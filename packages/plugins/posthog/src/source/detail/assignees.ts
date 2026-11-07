import type { PosthogApiClient, PosthogRequestOptions, PosthogResult } from '../../api/client.js';
import { isForwardDirectoryContinuation, parsePosthogDirectoryPage } from '../../api/types/directory.js';
import { readLowercaseUuid, readObject, readSafeInteger, readString } from '../../api/types/primitives.js';
import type { PosthogAssignmentChoiceV1 } from './nativeOverviewContract.js';

function parseChoice(value: unknown, kind: 'user' | 'role'): PosthogAssignmentChoiceV1 | null {
    const row = readObject(value);
    if (row === null) return null;
    if (kind === 'role') {
        const id = readLowercaseUuid(row['id']);
        const name = readString(row['name'])?.trim();
        return id === null || !name ? null : { assignee: { type: 'role', id }, name };
    }
    const user = readObject(row['user']);
    if (user === null) return null;
    const id = readSafeInteger(user['id']);
    const name = [readString(user['first_name']), readString(user['last_name'])].filter(Boolean).join(' ').trim()
        || readString(user['email'])?.trim();
    return id === null || id <= 0 || !name ? null : { assignee: { type: 'user', id }, name };
}

/**
 * PostHog's own assignee picker consumes organization members and roles. The public
 * members / roles references specify DRF limit/offset pages and their separate read
 * scopes; the provider's next URL supplies the page size rather than a local ceiling.
 * https://posthog.com/docs/api/members · https://posthog.com/docs/api/roles
 */
export async function readPosthogAssignmentChoices(
    client: PosthogApiClient,
    organizationUuid: string,
    options: PosthogRequestOptions,
): Promise<PosthogResult<readonly PosthogAssignmentChoiceV1[]>> {
    const choices: PosthogAssignmentChoiceV1[] = [];
    for (const kind of ['user', 'role'] as const) {
        const path = `/api/organizations/${encodeURIComponent(organizationUuid)}/${kind === 'user' ? 'members' : 'roles'}/`;
        let query: Record<string, string> | undefined;
        let requestedUrl = path;
        while (true) {
            const page = await client.requestJson({ method: 'GET', path, ...(query === undefined ? {} : { query }) },
                body => parsePosthogDirectoryPage(body, value => parseChoice(value, kind)), options);
            if (!page.ok) return page;
            if (page.value.nextUnreadable || page.value.skippedRowCount > 0) {
                return { ok: false, failure: { kind: 'malformedResponse', at: 'assignmentDirectory' } };
            }
            choices.push(...page.value.rows);
            if (page.value.next === null) break;
            const admitted = client.admitProviderUrl(page.value.next);
            if (admitted === null) return { ok: false, failure: { kind: 'malformedResponse', at: 'assignmentDirectoryNext' } };
            const next = new URL(admitted);
            if (!isForwardDirectoryContinuation(requestedUrl, admitted)) {
                return { ok: false, failure: { kind: 'malformedResponse', at: 'assignmentDirectoryNext' } };
            }
            requestedUrl = admitted;
            query = Object.fromEntries(next.searchParams);
        }
    }
    return { ok: true, value: choices };
}
