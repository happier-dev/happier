import type { ResumeCapabilityOptions } from '@/agents/runtime/resumeCapabilities';
import { INSTALLABLE_KEYS } from '@happier-dev/protocol/installables';
import { resolveCodexSpawnExtrasFromSettings } from '@happier-dev/agents';

import type {
    AgentResumeExperiments,
    AgentUiBehavior,
    NewSessionPreflightContext,
    NewSessionPreflightIssue,
    NewSessionRelevantInstallableDepsContext,
} from '@/agents/registry/registryUiBehavior';

const CODEX_SWITCH_RESUME_ACP = 'resumeAcp';

function getSwitch(experiments: AgentResumeExperiments, id: string): boolean {
    return experiments.switches[id] === true;
}

export type CodexSpawnSessionExtras = Readonly<{
    experimentalCodexAcp: boolean;
}>;

export type CodexResumeSessionExtras = Readonly<{
    experimentalCodexAcp: boolean;
}>;

export function computeCodexSpawnSessionExtras(opts: {
    agentId: string;
    experiments: AgentResumeExperiments;
    resumeSessionId: string;
}): CodexSpawnSessionExtras | null {
    if (opts.agentId !== 'codex') return null;
    if (opts.experiments.enabled !== true) return null;
    return {
        experimentalCodexAcp: getSwitch(opts.experiments, CODEX_SWITCH_RESUME_ACP) === true,
    };
}

export function computeCodexResumeSessionExtras(opts: {
    agentId: string;
    experiments: AgentResumeExperiments;
}): CodexResumeSessionExtras | null {
    if (opts.agentId !== 'codex') return null;
    if (opts.experiments.enabled !== true) return null;
    return {
        experimentalCodexAcp: getSwitch(opts.experiments, CODEX_SWITCH_RESUME_ACP) === true,
    };
}

export function getCodexNewSessionPreflightIssues(ctx: NewSessionPreflightContext): readonly NewSessionPreflightIssue[] {
    if (ctx.agentId !== 'codex') return [];
    // Codex ACP can run via npx fallback; do not block new sessions when the optional dep isn't installed.
    return [];
}

export function getCodexNewSessionRelevantInstallableDepKeys(ctx: NewSessionRelevantInstallableDepsContext): readonly string[] {
    if (ctx.agentId !== 'codex') return [];
    if (ctx.experiments.enabled !== true) return [];

    const extras = computeCodexSpawnSessionExtras({
        agentId: 'codex',
        experiments: ctx.experiments,
        resumeSessionId: ctx.resumeSessionId,
    });

    const keys: string[] = [];
    if (extras?.experimentalCodexAcp === true) keys.push(INSTALLABLE_KEYS.CODEX_ACP);
    return keys;
}

export const CODEX_UI_BEHAVIOR_OVERRIDE: AgentUiBehavior = {
    resume: {
        experimentSwitches: [
            { id: CODEX_SWITCH_RESUME_ACP, getValue: (settings) => settings.codexBackendMode === 'acp' },
        ],
    },
    newSession: {
        getPreflightIssues: getCodexNewSessionPreflightIssues,
        getRelevantInstallableDepKeys: getCodexNewSessionRelevantInstallableDepKeys,
    },
    payload: {
        buildSpawnSessionExtras: ({ agentId, experiments, resumeSessionId }) => {
            const extras = computeCodexSpawnSessionExtras({
                agentId,
                experiments,
                resumeSessionId,
            });
            return extras ?? {};
        },
        buildResumeSessionExtras: ({ agentId, experiments }) => {
            const extras = computeCodexResumeSessionExtras({
                agentId,
                experiments,
            });
            return extras ?? {};
        },
        buildWakeResumeExtras: ({ resumeCapabilityOptions }: { resumeCapabilityOptions: ResumeCapabilityOptions }) => {
            const settings = resumeCapabilityOptions.accountSettings ?? {};
            const extras = resolveCodexSpawnExtrasFromSettings(settings);
            return extras.experimentalCodexAcp === true ? { experimentalCodexAcp: true } : {};
        },
    },
};
