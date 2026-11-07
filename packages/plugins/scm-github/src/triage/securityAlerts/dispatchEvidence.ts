import type { SessionInputForgeEvidenceV1 } from '@happier-dev/plugin-sdk/sessions';
import { isExternalActionResultWithinResponseEnvelopeLimitV1 } from '@happier-dev/plugin-sdk/actions';
import type { TriageGetResultV1 } from '@happier-dev/triage-protocol/v1';

import { decodeGithubCodeScanningInstance, githubSecurityRecord, type GithubSecurityAlertV1 } from './contracts.js';

const text = (value: unknown): string | null => typeof value === 'string' ? value : null;
const record = (value: unknown): Readonly<Record<string, unknown>> => githubSecurityRecord(value) ?? {};

const OMITTED = '\n[Incomplete: additional alert evidence omitted to fit the Action response budget.]';
type PresentGet = Extract<TriageGetResultV1, { kind: 'present' }>;

/** The containing Action envelope owns the only size boundary on selected evidence. */
export function withGithubSecurityAlertDispatchEvidence(result: PresentGet, dispatchEvidence: SessionInputForgeEvidenceV1): PresentGet {
    const complete = { ...result, dispatchEvidence };
    if (isExternalActionResultWithinResponseEnvelopeLimitV1(complete)) return complete;

    const project = (textUnits: number): PresentGet => ({ ...result, dispatchEvidence: { v: 1,
        items: dispatchEvidence.items.map(item => {
            const available = Math.min(textUnits, item.text.length);
            textUnits -= available;
            // Preserve a whole Unicode code point at the retained prefix boundary.
            const end = available > 0 && available < item.text.length
                && /[\uD800-\uDBFF]/u.test(item.text[available - 1]!) ? available - 1 : available;
            return end === item.text.length ? item : { ...item, text: item.text.slice(0, end) + OMITTED };
        }) } });
    let lower = 0;
    let upper = dispatchEvidence.items.reduce((total, item) => total + item.text.length, 0);
    let fitted = project(0);
    if (!isExternalActionResultWithinResponseEnvelopeLimitV1(fitted)) {
        // Provider-authored labels/URLs can themselves exhaust the envelope.
        // Keep the exact observation and disclose that its detail was omitted.
        return { ...result, dispatchEvidence: { v: 1, items: [{ source: { kind: 'alert', label: 'Selected alert' },
            author: { kind: 'unknown' }, text: OMITTED.trimStart() }] } };
    }
    while (lower < upper) {
        const middle = Math.ceil((lower + upper) / 2);
        const candidate = project(middle);
        if (isExternalActionResultWithinResponseEnvelopeLimitV1(candidate)) {
            lower = middle;
            fitted = candidate;
        } else {
            upper = middle - 1;
        }
    }
    return fitted;
}

/** Complete selected native evidence. No provider text becomes a task or target. */
export function projectGithubSecurityAlertDispatchEvidence(alert: GithubSecurityAlertV1): SessionInputForgeEvidenceV1 {
    const source = { kind: 'alert' as const,
        label: `${alert.kindId === 'dependabot-alert' ? 'Dependabot' : 'Code scanning'} alert #${alert.number}`,
        ...(alert.webUrl === null ? {} : { url: alert.webUrl }) };
    const native = alert.native;
    const lines = [`state: ${alert.state}`, `security severity: ${alert.securitySeverity ?? 'unknown'}`];
    const field = (label: string, value: unknown): void => {
        const valueText = text(value);
        if (valueText !== null) lines.push(`${label}: ${valueText}`);
    };
    if (alert.kindId === 'dependabot-alert') {
        const advisory = record(native.security_advisory);
        const dependency = record(native.dependency);
        const pkg = record(dependency.package);
        const vulnerability = record(native.security_vulnerability);
        field('advisory', advisory.ghsa_id);
        field('summary', advisory.summary);
        field('package', pkg.name);
        field('ecosystem', pkg.ecosystem);
        field('manifest', dependency.manifest_path);
        field('dependency scope', dependency.scope);
        field('dependency relationship', dependency.relationship);
        field('affected range', vulnerability.vulnerable_version_range);
        field('first patched version', record(vulnerability.first_patched_version).identifier);
        field('advisory description', advisory.description);
    } else {
        const rule = record(native.rule);
        const tool = record(native.tool);
        field('rule', rule.id);
        field('rule name', rule.name);
        field('rule severity', rule.severity);
        field('rule description', rule.full_description ?? rule.description);
        field('rule help', rule.help);
        field('tool', tool.name);
        field('tool version', tool.version);
        const location = decodeGithubCodeScanningInstance(native.most_recent_instance);
        if (location !== null) {
            lines.push(`commit: ${location.commitSha}`, `path: ${location.path}`,
                `lines: ${location.startLine}-${location.endLine}`, `message: ${location.message}`);
            field('ref', location.ref);
            field('analysis key', location.analysisKey);
            field('environment', location.environment);
            field('category', location.category);
        }
    }
    const items: SessionInputForgeEvidenceV1['items'][number][] = [{ source, author: { kind: 'unknown' }, text: lines.join('\n') }];
    const dismissalComment = text(native.dismissed_comment);
    if (dismissalComment !== null) {
        const actor = record(native.dismissed_by);
        const label = text(actor.login);
        items.push({ source, author: { kind: actor.type === 'Bot' ? 'bot' : actor.type === 'User' ? 'person' : 'unknown',
            ...(label === null ? {} : { label }) }, text: dismissalComment });
    }
    return { v: 1, items };
}
