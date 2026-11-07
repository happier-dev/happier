import { MAX_TRIAGE_TEXT_UTF8_BYTES_V1, MAX_TRIAGE_ROW_FACT_VALUE_UTF8_BYTES_V1, projectTriageDisplayTextV1 } from '@happier-dev/triage-protocol/v1';
import { buildGithubEntryLocalRef } from '../identity.js';
import { buildGithubEntryLocator, parseGithubRoutingToken } from '../locator.js';
import type { GithubTriagePresentObservationV1, GithubTriageRowFactV1, GithubTriageViewerFactsV1 } from '../types.js';
import { decodeGithubCodeScanningInstance, githubSecurityRecord, type GithubSecurityAlertV1 } from './contracts.js';

/** One projection feeds list, exact detail, mutation readback and Session evidence. */
export function projectGithubSecurityAlert(input: Readonly<{
  alert: GithubSecurityAlertV1;
  repositoryId: string;
  repositoryKey: string;
  previous?: GithubTriagePresentObservationV1;
}>): GithubTriagePresentObservationV1 | null {
  const { alert } = input;
  const route = parseGithubRoutingToken(input.repositoryKey);
  const localRef = buildGithubEntryLocalRef({ kindId: alert.kindId, repositoryId: input.repositoryId, nativeItemId: alert.number });
  if (route === null || localRef === null) return null;
  const locator = buildGithubEntryLocator({ ...route, entryNumber: alert.number, webUrl: alert.webUrl });
  if (locator === null) return null;
  const previous = input.previous?.localRef.kindId === localRef.kindId
    && input.previous.localRef.collisionScope === localRef.collisionScope && input.previous.localRef.entryId === localRef.entryId
    ? input.previous : undefined;
  const presentation = alert.state === 'open' ? 'active' : alert.state === 'fixed' ? 'resolved'
    : alert.state === 'dismissed' || alert.kindId === 'dependabot-alert' && alert.state === 'auto_dismissed' ? 'suppressed' : 'unknown';
  const state = previous?.snapshot.state.presentation === presentation && previous.snapshot.state.nativeLabel === alert.state
    ? previous.snapshot.state : { presentation, nativeLabel: alert.state } as const;
  const title = projectTriageDisplayTextV1(alert.title, MAX_TRIAGE_TEXT_UTF8_BYTES_V1);
  let projectionTruncated = title.truncated;
  const nativeSeverity = alert.securitySeverity?.toLowerCase() ?? 'unknown';
  const severity = ['critical', 'high', 'medium', 'low'].includes(nativeSeverity) ? nativeSeverity : 'unknown';
  const severityLabel = severity === 'unknown' ? 'Unknown severity' : `${severity[0]?.toUpperCase()}${severity.slice(1)}`;
  const facts: GithubTriageRowFactV1[] = [{ id: 'github/security-severity', importance: 'primary', value: { kind: 'status',
    value: severityLabel, tone: severity === 'critical' || severity === 'high' ? 'danger' : severity === 'medium' ? 'warning' : 'neutral' } }];
  const addText = (id: string, text: unknown) => {
    if (typeof text !== 'string' || text.trim() === '') return;
    const projected = projectTriageDisplayTextV1(text, MAX_TRIAGE_ROW_FACT_VALUE_UTF8_BYTES_V1);
    projectionTruncated ||= projected.truncated;
    if (projected.value !== '') facts.push({ id: `github/${id}`, importance: 'secondary', value: { kind: 'text', value: projected.value } });
  };
  const dependency = githubSecurityRecord(alert.native.dependency);
  const packageRecord = githubSecurityRecord(dependency?.package);
  if (alert.kindId === 'dependabot-alert') {
    addText('package', typeof packageRecord?.name === 'string'
      ? `${typeof packageRecord.ecosystem === 'string' ? `${packageRecord.ecosystem}: ` : ''}${packageRecord.name}` : undefined);
    addText('manifest', dependency?.manifest_path);
    const vulnerability = githubSecurityRecord(alert.native.security_vulnerability);
    const patched = githubSecurityRecord(vulnerability?.first_patched_version);
    if (typeof vulnerability?.vulnerable_version_range === 'string' || typeof patched?.identifier === 'string') {
      addText('versions', `Affected ${typeof vulnerability?.vulnerable_version_range === 'string' ? vulnerability.vulnerable_version_range : 'unknown'}; patched ${typeof patched?.identifier === 'string' ? patched.identifier : 'not supplied'}`);
    }
  } else {
    const rule = githubSecurityRecord(alert.native.rule);
    addText('rule-level', [rule?.id, alert.ruleSeverity].filter(value => typeof value === 'string').join(' · '));
    const instance = githubSecurityRecord(alert.native.most_recent_instance);
    addText('message', githubSecurityRecord(instance?.message)?.text);
    const location = decodeGithubCodeScanningInstance(instance);
    if (location !== null) addText('location', `${location.path}:${location.startLine}-${location.endLine} @${location.commitSha}`);
  }
  const sameFact = (left: GithubTriageRowFactV1, right: GithubTriageRowFactV1): boolean => left.id === right.id
    && left.importance === right.importance && (left.value.kind === 'text' && right.value.kind === 'text'
      ? left.value.value === right.value.value : left.value.kind === 'status' && right.value.kind === 'status'
        && left.value.value === right.value.value && left.value.tone === right.value.tone);
  const reconciledFacts = facts.map(fact => previous?.snapshot.rowFacts.find(prior => sameFact(fact, prior)) ?? fact);
  const rowFacts = previous?.snapshot.rowFacts.length === reconciledFacts.length
    && reconciledFacts.every((fact, index) => fact === previous.snapshot.rowFacts[index]) ? previous.snapshot.rowFacts : reconciledFacts;
  const required = alert.state === 'open' && (severity === 'critical' || severity === 'high');
  // The row's fact is the bare level beside its own column; the chip stands alone, so it says what the level is of.
  const reasonLabel = `${severityLabel} severity`;
  const oldAttention = previous?.viewer.sourceAttention;
  const sourceAttention = required
    ? oldAttention?.level === 'required' && oldAttention.reasonLabel === reasonLabel ? oldAttention
      : { level: 'required' as const, reasonId: 'github-security-severity', reasonLabel }
    : oldAttention?.level === 'none' ? oldAttention : { level: 'none' as const };
  const viewer: GithubTriageViewerFactsV1 = previous?.viewer.sourceAttention === sourceAttention ? previous.viewer
    : { involvement: [], sourceAttention };
  const snapshot = previous !== undefined && previous.snapshot.title === title.value
    && previous.snapshot.scopeLabel === input.repositoryKey && previous.snapshot.webUrl === locator.webUrl
    && previous.snapshot.createdAtMs === alert.createdAtMs && previous.snapshot.completedAtMs === alert.completedAtMs
    && previous.snapshot.sourceUpdatedAtMs === alert.updatedAtMs && previous.snapshot.state === state
    && previous.snapshot.rowFacts === rowFacts && previous.snapshot.projectionTruncated === projectionTruncated
    ? previous.snapshot : { kindId: alert.kindId, title: title.value, scopeLabel: input.repositoryKey,
      designation: `#${alert.number}`, webUrl: locator.webUrl, nameWithOwner: input.repositoryKey,
      createdAtMs: alert.createdAtMs, ...(alert.completedAtMs === undefined ? {} : { completedAtMs: alert.completedAtMs }),
      sourceUpdatedAtMs: alert.updatedAtMs, nativeRevision: String(alert.updatedAtMs), state, rowFacts,
      projectionTruncated };
  return previous?.snapshot === snapshot && previous.viewer === viewer
    && previous.locator.routingToken === locator.routingToken && previous.locator.webUrl === locator.webUrl ? previous
    : { kind: 'present', localRef: previous?.localRef ?? localRef, locator, snapshot, viewer };
}
