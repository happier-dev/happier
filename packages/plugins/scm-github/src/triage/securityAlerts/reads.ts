import type { GithubTriageInvocationContext } from '../invocation.js';
import { isExternalActionResultWithinResponseEnvelopeLimitV1 } from '@happier-dev/plugin-sdk/actions';
import { fitActionResultTextV1 } from '@happier-dev/triage-sources/projection/actionResultText';
import { decodeTriagePagingTokenV1, encodeTriagePagingTokenV1, type TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';
import { decodeGithubJsonResponse, type GithubApiClientV1 } from '../../observations/githubApiClient.js';
import { admitGithubDetailInvocation, type GithubAdmittedDetailInvocationV1 } from '../admission.js';
import { classifyGithubResponseFailure, classifyGithubTransportFailure, GITHUB_ROUTE_BODY_MISMATCH_FAILURE, isGithubSuccessStatus } from '../errors.js';
import { buildGithubCollisionScope, buildGithubEntryLocalRef } from '../identity.js';
import { buildGithubApiUrl, buildGithubRepositoryKey, type GithubRepositoryRouteV1 } from '../locator.js';
import { toTriageObservation } from '../mapping/protocol.js';
import { sendGithubGraphqlRequest } from '../mutations/graphql.js';
import { readValidatedGithubCursorFollowUpPage, validateGithubCursorFollowUpUrl } from '../scan/link.js';
import type { GithubTriageEntryLocalRefV1, GithubTriagePresentObservationV1 } from '../types.js';
import { decodeGithubSecurityAlert, decodeGithubCodeScanningInstance, githubSecurityRecord, type GithubSecurityAlertV1, type GithubSecurityAlertKindV1 } from './contracts.js';
import { projectGithubSecurityAlert } from './mapping.js';
import {
  GithubSecurityAlertReadInputV1Schema, GithubCodeScanningLocationsInputV1Schema, GithubCodeScanningLocationInputV1Schema,
  GithubDependabotFixPullRequestInputV1Schema,
  type GithubSecurityAlertReadResultV1, type GithubCodeScanningLocationsResultV1, type GithubCodeScanningLocationResultV1,
  type GithubDependabotFixPullRequestResultV1, type GithubCodeScanningInstanceV1,
} from './actionContracts.js';

export const GITHUB_SECURITY_ALERT_INPUT_FAILURE: TriageSourceFailureV1 = Object.freeze({ class: 'unsupportedContract', code: 'github_security_alert_input_invalid' });
const PAYLOAD_INVALID: TriageSourceFailureV1 = Object.freeze({ class: 'unsupportedContract', code: 'github_security_alert_response_invalid' });
const CONTINUATION_INVALID: TriageSourceFailureV1 = Object.freeze({ class: 'unsupportedContract', code: 'github_security_alert_continuation_invalid' });
type Admitted = Extract<GithubAdmittedDetailInvocationV1, { ok: true }>;
type ReadDependencies = Readonly<{ client: GithubApiClientV1; now: () => number }>;
export type GithubSecurityAlertReadV1 = Readonly<{ kind: 'readable'; alert: GithubSecurityAlertV1; observation: GithubTriagePresentObservationV1 }> | Readonly<{ kind: 'unavailable'; failure: TriageSourceFailureV1 }>;
export function unavailableGithubSecurityAlert(failure: TriageSourceFailureV1) { return Object.freeze({ kind: 'unavailable' as const, failure }); }
const string = (value: unknown): string | null => typeof value === 'string' ? value : null;
const record = (value: unknown): Readonly<Record<string, unknown>> => githubSecurityRecord(value) ?? {};

/** Native paths are built from admitted identity, never a provider URL or caller path. */
export function buildGithubSecurityAlertUrl(input: Readonly<{ kindId: GithubSecurityAlertKindV1; route: GithubRepositoryRouteV1; entryNumber: string }>): string {
  if (!/^[1-9][0-9]*$/u.test(input.entryNumber)) throw new Error('github_security_alert_number_invalid');
  return buildGithubApiUrl(['repos', input.route.owner, input.route.name, input.kindId === 'dependabot-alert' ? 'dependabot' : 'code-scanning', 'alerts', input.entryNumber]);
}

export async function readGithubNativeSecurityAlert(input: Readonly<{ localRef: GithubTriageEntryLocalRefV1; route: GithubRepositoryRouteV1; repositoryId: string; repositoryKey: string }>, dependencies: ReadDependencies): Promise<GithubSecurityAlertReadV1> {
  if (input.localRef.kindId !== 'dependabot-alert' && input.localRef.kindId !== 'code-scanning-alert') return unavailableGithubSecurityAlert(GITHUB_SECURITY_ALERT_INPUT_FAILURE);
  if (buildGithubCollisionScope(input.repositoryId) !== input.localRef.collisionScope || !/^[1-9][0-9]*$/u.test(input.localRef.entryId)) return unavailableGithubSecurityAlert(GITHUB_ROUTE_BODY_MISMATCH_FAILURE);
  try {
    const response = await dependencies.client.request({ url: buildGithubSecurityAlertUrl({ kindId: input.localRef.kindId, route: input.route, entryNumber: input.localRef.entryId }) });
    // Alert authorization/feature masking is independent of repository readability.
    // A bare 404/410 never proves this retained finding absent.
    if (!isGithubSuccessStatus(response.status)) return unavailableGithubSecurityAlert(classifyGithubResponseFailure(response, dependencies.now()));
    const alert = decodeGithubSecurityAlert(input.localRef.kindId, decodeGithubJsonResponse(response));
    if (alert === null) return unavailableGithubSecurityAlert(PAYLOAD_INVALID);
    if (alert.number !== input.localRef.entryId) return unavailableGithubSecurityAlert(GITHUB_ROUTE_BODY_MISMATCH_FAILURE);
    const observation = projectGithubSecurityAlert({ alert, repositoryId: input.repositoryId, repositoryKey: input.repositoryKey });
    return observation === null ? unavailableGithubSecurityAlert(PAYLOAD_INVALID) : Object.freeze({ kind: 'readable', alert, observation });
  } catch (error) { return unavailableGithubSecurityAlert(classifyGithubTransportFailure(error)); }
}

export async function readAdmittedGithubSecurityAlert(admitted: Admitted): Promise<GithubSecurityAlertReadV1> {
  return readGithubNativeSecurityAlert({ localRef: admitted.localRef, route: admitted.route, repositoryId: admitted.repository.repositoryId, repositoryKey: admitted.repository.repositoryKey ?? `${admitted.route.owner}/${admitted.route.name}` }, { client: admitted.client, now: Date.now });
}

/** One selected detail demand; list and get deliberately never acquire these bodies separately. */
export async function readGithubSecurityAlert(input: unknown, context: GithubTriageInvocationContext): Promise<GithubSecurityAlertReadResultV1> {
  const parsed = GithubSecurityAlertReadInputV1Schema.safeParse(input);
  if (!parsed.success) return unavailableGithubSecurityAlert(GITHUB_SECURITY_ALERT_INPUT_FAILURE);
  const admitted = await admitGithubDetailInvocation({ ...parsed.data, admissibleKinds: ['dependabot-alert', 'code-scanning-alert'] }, context);
  if (!admitted.ok) return unavailableGithubSecurityAlert(admitted.failure);
  const read = await readAdmittedGithubSecurityAlert(admitted);
  if (read.kind === 'unavailable') return read;
  const native = read.alert.native;
  const common = {
    nativeState: read.alert.state, severity: read.alert.securitySeverity ?? 'unknown',
    url: read.alert.webUrl ?? `https://github.com/${admitted.route.owner}/${admitted.route.name}/security/${read.alert.kindId === 'dependabot-alert' ? 'dependabot' : 'code-scanning'}/${read.alert.number}`,
    dismissedReason: string(native.dismissed_reason), dismissedComment: string(native.dismissed_comment), dismissedBy: string(record(native.dismissed_by).login), dismissedAt: string(native.dismissed_at), projectionTruncated: false,
  };
  const observation = toTriageObservation(read.observation);
  let result: GithubSecurityAlertReadResultV1;
  if (read.alert.kindId === 'dependabot-alert') {
    const dependency = record(native.dependency); const pkg = record(dependency.package); const advisory = record(native.security_advisory); const vulnerability = record(native.security_vulnerability);
    result = { kind: 'alert', kindId: 'dependabot-alert', observation, detail: { ...common,
      summary: string(advisory.summary) ?? read.alert.title, advisory: string(advisory.description) ?? '', advisoryId: string(advisory.ghsa_id),
      packageName: string(pkg.name) ?? '', ecosystem: string(pkg.ecosystem) ?? '', manifestPath: string(dependency.manifest_path) ?? '', dependencyScope: string(dependency.scope), relationship: string(dependency.relationship), affectedRange: string(vulnerability.vulnerable_version_range), patchedVersion: string(record(vulnerability.first_patched_version).identifier),
    } };
  } else {
    const rule = record(native.rule); const tool = record(native.tool); const instance = decodeGithubCodeScanningInstance(native.most_recent_instance);
    result = { kind: 'alert', kindId: 'code-scanning-alert', observation, detail: { ...common, ruleId: string(rule.id), ruleName: string(rule.name) ?? read.alert.title, ruleDescription: string(rule.full_description) ?? string(rule.description) ?? '', ruleHelp: string(rule.help), ruleSeverity: string(rule.severity), toolName: string(tool.name) ?? '', toolVersion: string(tool.version), message: instance?.message ?? '', location: instance } };
  }
  try { return fitGithubSecurityAlertDetail(result); }
  catch { return unavailableGithubSecurityAlert({ class: 'unsupportedContract', code: 'github_security_alert_detail_transport_limit' }); }
}

/** Shares the real response budget across free-text evidence while retaining identity and coordinates. */
function fitAlertTextParts<TResult>(parts: readonly (string | null)[], project: (parts: readonly (string | null)[], truncated: boolean) => TResult): TResult {
  const joined = parts.map(value => value ?? '').join('');
  return fitActionResultTextV1(joined, (prefix, truncated) => {
    let offset = 0;
    const projected = parts.map(value => {
      if (value === null) return null;
      const part = prefix.slice(offset, offset + value.length);
      offset += value.length;
      return part;
    });
    return project(projected, truncated);
  });
}
function fitGithubSecurityAlertDetail(result: Extract<GithubSecurityAlertReadResultV1, { kind: 'alert' }>): GithubSecurityAlertReadResultV1 {
  if (result.kindId === 'dependabot-alert') {
    const detail = result.detail;
    return fitAlertTextParts([detail.summary, detail.advisory, detail.dismissedComment], (parts, projectionTruncated) => ({ ...result,
      detail: { ...detail, summary: parts[0] ?? '', advisory: parts[1] ?? '', dismissedComment: parts[2] ?? null, projectionTruncated } }));
  }
  const detail = result.detail;
  return fitAlertTextParts([detail.ruleName, detail.message, detail.location?.message ?? null, detail.ruleDescription, detail.ruleHelp, detail.dismissedComment], (parts, projectionTruncated) => ({ ...result,
    detail: { ...detail, ruleName: parts[0] ?? '', message: parts[1] ?? '', ruleDescription: parts[3] ?? '', ruleHelp: parts[4] ?? null,
      location: detail.location === null ? null : { ...detail.location, message: parts[2] ?? '' }, dismissedComment: parts[5] ?? null, projectionTruncated } }));
}

function buildLocationsUrl(admitted: Admitted, limit: number): string {
  const url = new URL(`${buildGithubSecurityAlertUrl({ kindId: 'code-scanning-alert', route: admitted.route, entryNumber: admitted.entryNumber })}/instances`);
  url.searchParams.set('per_page', String(limit)); url.searchParams.set('page', '1'); return url.toString();
}
type LocationsInput = ReturnType<typeof GithubCodeScanningLocationsInputV1Schema.parse>;
function locationsAuthority(request: LocationsInput): string {
  // Non-secret configured authority only; no native body or token material enters paging state.
  return JSON.stringify({ source: request.instance.instance, localInstanceKey: request.instance.localInstanceKey, binding: request.instance.binding, configuration: request.instance.configuration, localRef: request.localRef, routingToken: request.routingToken, limit: request.limit });
}
function resolveLocationsUrl(request: LocationsInput, admitted: Admitted): string | null {
  const initial = buildLocationsUrl(admitted, request.limit);
  if (request.continuation === undefined) return initial;
  const decoded = decodeTriagePagingTokenV1(request.continuation);
  if (decoded === null || decoded.v !== 1 || decoded.authority !== locationsAuthority(request) || typeof decoded.url !== 'string') return null;
  return validateGithubCursorFollowUpUrl(decoded.url, initial, admitted.repository.repositoryId);
}
async function readLocationsPage(request: LocationsInput, admitted: Admitted): Promise<GithubCodeScanningLocationsResultV1> {
  const url = resolveLocationsUrl(request, admitted);
  if (url === null) return unavailableGithubSecurityAlert(CONTINUATION_INVALID);
  try {
    const response = await admitted.client.request({ url });
    if (!isGithubSuccessStatus(response.status)) return unavailableGithubSecurityAlert(classifyGithubResponseFailure(response, Date.now()));
    const raw = decodeGithubJsonResponse(response);
    if (!Array.isArray(raw)) return unavailableGithubSecurityAlert(PAYLOAD_INVALID);
    const rows = raw.map(decodeGithubCodeScanningInstance);
    if (rows.some(row => row === null) || rows.length > request.limit) return unavailableGithubSecurityAlert(PAYLOAD_INVALID);
    const next = readValidatedGithubCursorFollowUpPage(response.headers, url, admitted.repository.repositoryId);
    const continuation = next.kind === 'next' ? encodeTriagePagingTokenV1({ v: 1, authority: locationsAuthority(request), url: next.url }) : null;
    const result = { kind: 'locations' as const, rows: rows.filter((row): row is GithubCodeScanningInstanceV1 => row !== null),
      ...(continuation === null ? {} : { continuation }), ...(next.kind === 'invalid' || (next.kind === 'next' && continuation === null) ? { incomplete: 'pagination' as const } : {}) };
    return isExternalActionResultWithinResponseEnvelopeLimitV1(result) ? result : unavailableGithubSecurityAlert({ class: 'unsupportedContract', code: 'github_security_alert_locations_transport_limit' });
  } catch (error) { return unavailableGithubSecurityAlert(classifyGithubTransportFailure(error)); }
}
export async function listGithubCodeScanningLocations(input: unknown, context: GithubTriageInvocationContext): Promise<GithubCodeScanningLocationsResultV1> {
  const parsed = GithubCodeScanningLocationsInputV1Schema.safeParse(input);
  if (!parsed.success) return unavailableGithubSecurityAlert(GITHUB_SECURITY_ALERT_INPUT_FAILURE);
  const admitted = await admitGithubDetailInvocation({ ...parsed.data, admissibleKinds: ['code-scanning-alert'] }, context);
  return admitted.ok ? readLocationsPage(parsed.data, admitted) : unavailableGithubSecurityAlert(admitted.failure);
}
function sameInstance(left: GithubCodeScanningInstanceV1, right: GithubCodeScanningInstanceV1): boolean {
  return left.commitSha === right.commitSha && left.path === right.path && left.ref === right.ref && left.analysisKey === right.analysisKey && left.category === right.category && left.environment === right.environment && left.startLine === right.startLine && left.endLine === right.endLine && left.startColumn === right.startColumn && left.endColumn === right.endColumn;
}
export async function readGithubCodeScanningLocation(input: unknown, context: GithubTriageInvocationContext): Promise<GithubCodeScanningLocationResultV1> {
  const parsed = GithubCodeScanningLocationInputV1Schema.safeParse(input);
  if (!parsed.success) return unavailableGithubSecurityAlert(GITHUB_SECURITY_ALERT_INPUT_FAILURE);
  const admitted = await admitGithubDetailInvocation({ ...parsed.data, admissibleKinds: ['code-scanning-alert'] }, context);
  if (!admitted.ok) return unavailableGithubSecurityAlert(admitted.failure);
  // Read the provider page again. The caller's path and commit are only selection operands.
  const page = await readLocationsPage(parsed.data, admitted);
  if (page.kind === 'unavailable') return page;
  const location = page.rows.find(row => sameInstance(row, parsed.data.selectedInstance));
  if (location === undefined) return unavailableGithubSecurityAlert({ class: 'unknown', code: 'github_code_scanning_instance_changed' });
  const sourceUrl = `https://github.com/${admitted.route.owner}/${admitted.route.name}/blob/${location.commitSha}/${location.path.split('/').map(encodeURIComponent).join('/')}#L${location.startLine}-L${location.endLine}`;
  const noCode = (failure: TriageSourceFailureV1): GithubCodeScanningLocationResultV1 => ({ kind: 'location', location, code: null, codeUnavailable: failure, firstLine: location.startLine, lastLine: location.endLine, totalLines: 0, sourceUrl, projectionTruncated: false });
  try {
    const url = new URL(buildGithubApiUrl(['repos', admitted.route.owner, admitted.route.name, 'contents', ...location.path.split('/')]));
    url.searchParams.set('ref', location.commitSha);
    const response = await admitted.client.request({ url: url.toString() });
    if (!isGithubSuccessStatus(response.status)) return noCode(classifyGithubResponseFailure(response, Date.now()));
    const body = record(decodeGithubJsonResponse(response));
    if (body.type !== 'file' || body.encoding !== 'base64' || typeof body.content !== 'string') return noCode({ class: 'unsupportedContract', code: 'github_code_content_unavailable' });
    const base64 = body.content.replace(/\s/gu, '');
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(base64)) return noCode(PAYLOAD_INVALID);
    const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
    if (bytes.includes(0)) return noCode({ class: 'unsupportedContract', code: 'github_code_content_binary' });
    let content: string;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return noCode({ class: 'unsupportedContract', code: 'github_code_content_binary' }); }
    const lines = content.split(/\r?\n/u); if (lines.at(-1) === '') lines.pop();
    if (location.startLine > lines.length || location.endLine > lines.length) return noCode({ class: 'unknown', code: 'github_code_location_unavailable' });
    return fitActionResultTextV1(lines.slice(location.startLine - 1, location.endLine).join('\n'), (code, projectionTruncated) => ({ kind: 'location' as const, location, code, firstLine: location.startLine,
      lastLine: projectionTruncated ? Math.min(location.endLine, location.startLine + code.split('\n').length - 1) : location.endLine, totalLines: lines.length, sourceUrl, projectionTruncated }));
  } catch (error) { return noCode(classifyGithubTransportFailure(error)); }
}

/** Exact association, with field-level GraphQL failures distinct from a native null. */
export async function readGithubDependabotFixPullRequest(input: unknown, context: GithubTriageInvocationContext): Promise<GithubDependabotFixPullRequestResultV1> {
  const parsed = GithubDependabotFixPullRequestInputV1Schema.safeParse(input);
  if (!parsed.success) return unavailableGithubSecurityAlert(GITHUB_SECURITY_ALERT_INPUT_FAILURE);
  const admitted = await admitGithubDetailInvocation({ ...parsed.data, admissibleKinds: ['dependabot-alert'] }, context);
  if (!admitted.ok) return unavailableGithubSecurityAlert(admitted.failure);
  const number = Number(admitted.entryNumber);
  if (!Number.isSafeInteger(number) || number < 1) return unavailableGithubSecurityAlert(GITHUB_SECURITY_ALERT_INPUT_FAILURE);
  const response = await sendGithubGraphqlRequest({ query: 'query HappierAlertUpdate($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){databaseId nameWithOwner vulnerabilityAlert(number:$number){number dependabotUpdate{pullRequest{number title url state repository{databaseId nameWithOwner}}}}}}', variables: { owner: admitted.route.owner, name: admitted.route.name, number }, readOnlyGraphql: true }, { client: admitted.client, now: Date.now });
  if (!response.ok) return unavailableGithubSecurityAlert(response.failure);
  const repository = record(response.data.repository);
  if (buildGithubCollisionScope(repository.databaseId) !== admitted.localRef.collisionScope) return unavailableGithubSecurityAlert(GITHUB_ROUTE_BODY_MISMATCH_FAILURE);
  const alert = record(repository.vulnerabilityAlert);
  if (alert.number !== number) return unavailableGithubSecurityAlert(PAYLOAD_INVALID);
  if (alert.dependabotUpdate === null) return { kind: 'none' };
  const update = record(alert.dependabotUpdate);
  if (update.pullRequest === null) return { kind: 'none' };
  const pr = record(update.pullRequest); const prRepository = record(pr.repository);
  if (buildGithubCollisionScope(prRepository.databaseId) !== admitted.localRef.collisionScope) return unavailableGithubSecurityAlert(GITHUB_ROUTE_BODY_MISMATCH_FAILURE);
  const localRef = buildGithubEntryLocalRef({ kindId: 'pull-request', repositoryId: prRepository.databaseId, nativeItemId: pr.number });
  const routingToken = buildGithubRepositoryKey(admitted.route);
  if (localRef === null || routingToken === null || typeof pr.title !== 'string' || typeof pr.state !== 'string') return unavailableGithubSecurityAlert(PAYLOAD_INVALID);
  const expectedUrl = `https://github.com/${routingToken}/pull/${localRef.entryId}`;
  if (typeof pr.url !== 'string' || pr.url.toLowerCase() !== expectedUrl.toLowerCase()) return unavailableGithubSecurityAlert(GITHUB_ROUTE_BODY_MISMATCH_FAILURE);
  return { kind: 'pullRequest', localRef, routingToken, url: pr.url, title: pr.title, state: pr.state };
}
