import type {
    AgentExternalSessionTakeoverContribution,
    AgentExternalSessionTakeoverLaunchPlan,
    AgentExternalSessionTakeoverResolveLaunchRequest,
} from '@happier-dev/plugin-sdk/experimental/sessions';

type ClaudeExternalSessionTakeoverIdentity =
    Pick<
        AgentExternalSessionTakeoverResolveLaunchRequest,
        'source' | 'remoteSessionId' | 'linkData' | 'linkedDirectory'
    >;

function readNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed || null;
}

export function resolveClaudeExternalSessionTakeoverPlan(
    identity: ClaudeExternalSessionTakeoverIdentity,
): AgentExternalSessionTakeoverLaunchPlan | null {
    const remoteSessionId = readNonEmptyString(identity.remoteSessionId);
    const directory = readNonEmptyString(identity.linkedDirectory);
    const configDir = readNonEmptyString(identity.source.configDir);
    const sourceProjectId = readNonEmptyString(identity.source.projectId);
    const linkedProjectId = readNonEmptyString(identity.linkData.projectId);
    if (
        identity.source.kind !== 'claudeConfig'
        || !remoteSessionId
        || !directory
        || !configDir
        || !sourceProjectId
        || sourceProjectId !== linkedProjectId
    ) {
        return null;
    }

    return Object.freeze({
        directory,
        environmentVariables: Object.freeze({
            CLAUDE_CONFIG_DIR: configDir,
        }),
    });
}

export const claudeExternalSessionTakeoverContribution:
    AgentExternalSessionTakeoverContribution = Object.freeze({
        resolveLaunch(request) {
            if (request.signal.aborted) {
                return { ok: false, code: 'cancelled' };
            }
            if (Date.now() >= request.deadlineAtMs) {
                return { ok: false, code: 'timeout', retryable: true };
            }
            if (!readNonEmptyString(request.linkedDirectory)) {
                return { ok: false, code: 'unavailable' };
            }
            const plan = resolveClaudeExternalSessionTakeoverPlan(request);
            return plan
                ? { ok: true, value: plan }
                : { ok: false, code: 'source_invalid' };
        },
    });
