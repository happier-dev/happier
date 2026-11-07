import type { JsonValue } from '@happier-dev/plugin-sdk';
import { requestTriageSessionHandoffV1, type TriageSessionHandoffHostV1 } from '@happier-dev/triage-sources/runtime';
import { ForgeReleaseActionResultSchemasV1, type ForgeReleaseActionInputByOperationV1 } from '@happier-dev/triage-protocol/releases/v1';
import type { TriageSessionHandoffInputV1 } from '@happier-dev/triage-protocol/v1';
import { GITHUB_PLUGIN_ID } from '../../observations/githubProviderContracts.js';
import { GITHUB_RELEASE_ACTION_IDS_V1 } from '../../releases/contracts.js';

/** Evidence only. L05A owns framing, choice, compose/send, Agent selection and approval. */
export async function requestReleaseNotesAssistanceV1(host: TriageSessionHandoffHostV1, input: Readonly<{
    target: ForgeReleaseActionInputByOperationV1['readLatestRelease'];
    selector: ForgeReleaseActionInputByOperationV1['readNotesContext']['selector']; proposedNotes?: string;
    workspace?: Extract<TriageSessionHandoffInputV1['context'], { kind: 'repository' }>['workspace'];
    configuredActionId: TriageSessionHandoffInputV1['configuredActionId']; sessionChoice: TriageSessionHandoffInputV1['sessionChoice'];
    agentChoice: TriageSessionHandoffInputV1['agentChoice']; delivery: TriageSessionHandoffInputV1['delivery'];
}>, options: Readonly<{ signal?: AbortSignal }> = {}): Promise<JsonValue | void> {
    if (options.signal?.aborted) return { kind: 'cancelled' };
    let response: JsonValue | void;
    try {
        response = await host.executeAction({ pluginId: GITHUB_PLUGIN_ID, localId: GITHUB_RELEASE_ACTION_IDS_V1.readNotesContext },
            { ...input.target, selector: input.selector }, options);
    } catch (error) {
        if (options.signal?.aborted) return { kind: 'cancelled' };
        throw error;
    }
    if (options.signal?.aborted) return { kind: 'cancelled' };
    const result = response && typeof response === 'object' && !Array.isArray(response)
        && 'ok' in response && response.ok === true && 'result' in response ? response.result : response;
    const parsed = ForgeReleaseActionResultSchemasV1.readNotesContext.safeParse(result);
    // A read's outer approval/refusal is retained; it cannot start or send a Session.
    if (!parsed.success || parsed.data.kind !== 'value') return response;
    return requestTriageSessionHandoffV1(host, {
        task: 'draftReleaseNotes', configuredActionId: input.configuredActionId,
        context: { kind: 'repository', repository: input.target.repository, ...(input.workspace === undefined ? {} : { workspace: input.workspace }) },
        evidence: [{ ...parsed.data.value, ...(input.proposedNotes === undefined ? {} : { proposedNotes: input.proposedNotes }) }],
        sessionChoice: input.sessionChoice, agentChoice: input.agentChoice, delivery: input.delivery,
    }, options);
}
