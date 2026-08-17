import type {
    AgentRuntimeFactory,
} from '@happier-dev/plugin-sdk/agents/runtime';
import type {
    AgentExternalSessionTranscriptRawRecord,
    AgentExternalSessionsContribution,
} from '@happier-dev/plugin-sdk/sessions/external';

/**
 * This is the Session-runner leaf named by the package-root locator. Keep it
 * import-safe: the daemon activation module and a Session runner can load it
 * in distinct realms, so it must not rely on a process-global singleton.
 */
export const createReviewAgentRuntime: AgentRuntimeFactory = () => ({
    sessions: {
        async open() {
            throw new Error('The reference Agent runtime is compile-only.');
        },
    },
});

/**
 * Every transcript item's `raw` must be this canonical record: a user turn is
 * `{ role: 'user', content: { type: 'text', text } }`, and an agent turn wraps
 * the provider-native body in an agent record — `{ type: 'acp', agentId, data }`
 * is the general form for an Agent that has no first-party content dialect.
 *
 * The host admits the contract once, when it accepts the transcript result, so
 * a bare provider-native envelope fails the whole page with `agent_error`
 * instead of reaching a reader that cannot parse it. Source-derived routing
 * facts such as `messageRole` and `localId` stay beside `raw`, never inside it.
 */
const userRecord: AgentExternalSessionTranscriptRawRecord = {
    role: 'user',
    content: { type: 'text', text: 'Review the staged diff.' },
};
const agentRecord: AgentExternalSessionTranscriptRawRecord = {
    role: 'agent',
    content: {
        type: 'acp',
        agentId: 'review',
        data: { type: 'message', message: 'Reviewed the staged diff.' },
    },
};

/**
 * The locator's optional companion is exported from this exact same leaf.
 * The host owns lifecycle, admission, and persisted External Session state.
 */
export const externalSessions: AgentExternalSessionsContribution = {
    async resolveSource({ source }) {
        return { ok: true, value: { source } };
    },
    async listCandidates() {
        return { ok: true, value: { candidates: [], nextCursor: null } };
    },
    async resolveLinkIdentity({ source, remoteSessionId }) {
        return { ok: true, value: { source, remoteSessionId, linkData: {} } };
    },
    async resolveLinkedIdentity({ source, remoteSessionId, linkData }) {
        return { ok: true, value: { source, remoteSessionId, linkData } };
    },
    async pageTranscript() {
        return {
            ok: true,
            value: {
                items: [{
                    id: 'review-1',
                    createdAtMs: 1_700_000_000_000,
                    messageRole: 'user',
                    raw: userRecord,
                }, {
                    id: 'review-2',
                    createdAtMs: 1_700_000_001_000,
                    messageRole: 'agent',
                    raw: agentRecord,
                }],
                nextCursor: null,
            },
        };
    },
    async readAfterTranscript() {
        return { ok: true, value: { outcome: 'already_current' } };
    },
};
