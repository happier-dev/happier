import { t } from '@/text';
import type { MachineAgentJob } from '../machineAgentTypes';
import { formatResetAtTime } from '@/utils/time/formatResetAtTime';
import { AgentInstallJobRpcError } from './api';

/** Transport and lookup failures do not establish an installer outcome. */
export function presentAgentInstallJobRpcFailure(error: unknown): Readonly<{ code: string; title: string; body: string }> {
    const code = error instanceof AgentInstallJobRpcError ? error.code : 'unknown';
    if (code === 'unavailable') {
        return { code, title: t('agentInstallJob.jobUnavailable'), body: t('agentInstallJob.jobUnavailableBody') };
    }
    if (code === 'request_failed') {
        return { code, title: t('agentInstallJob.machineUnreachable'), body: t('agentInstallJob.unreachableBody') };
    }
    if (code === 'job_not_found') {
        return { code, title: t('agentInstallJob.jobMissing'), body: t('agentInstallJob.jobMissingBody') };
    }
    if (code === 'member_install_unavailable') {
        return { code, title: t('agentInstallJob.jobUnavailable'), body: t('errors.agentIsolationMemberSetupAskManager') };
    }
    if (code === 'in_use') {
        return { code, title: t('agentInstallJob.inUse'), body: t('agentInstallJob.inUseBody') };
    }
    if (code === 'not_managed') {
        return { code, title: t('agentInstallJob.manualInstall'), body: t('agentInstallJob.notManagedBody') };
    }
    if (code === 'definition_version_changed') {
        return { code, title: t('agentInstallJob.jobUnavailable'), body: t('agentInstallJob.definitionChangedBody') };
    }
    const body = t('agentInstallJob.jobMissingBody');
    return { code, title: t('agentInstallJob.jobUnavailable'), body: error instanceof AgentInstallJobRpcError ? `${body} (${code})` : body };
}

/** Display uncertainty is not a daemon installer outcome. */
export type AgentInstallJobFailurePresentationInput =
    | Extract<NonNullable<MachineAgentJob['outcome']>, { kind: 'failed' }>
    | Readonly<{ kind: 'failed'; code: 'unknown'; stepId: null; message: null; guideUrl?: never }>;

export type AgentInstallJobFailurePresentation = Readonly<{
    code: AgentInstallJobFailurePresentationInput['code'];
    title: string;
    body: string;
    recovery: Readonly<{ kind: 'retry' | 'guide' | 'chooseAgent' | 'reconnect'; label: string; guideUrl?: string }>;
}>;

const ISO_INSTANT = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})/;

/** The installer states GitHub's reset as an ISO instant inside its credential-free message. */
function rateLimitBody(message: string | null): string {
    const iso = message?.match(ISO_INSTANT)?.[0];
    const resetAt = iso ? Date.parse(iso) : Number.NaN;
    return Number.isFinite(resetAt)
        ? t('agentInstallJob.rateLimitedBody', { time: formatResetAtTime(resetAt) })
        : t('agentInstallJob.rateLimitedBodyNoTime');
}

export function presentAgentInstallJobFailure(
    failure: AgentInstallJobFailurePresentationInput,
): AgentInstallJobFailurePresentation {
    const copy = (() => {
        switch (failure.code) {
            case 'in_use': return { title: t('agentInstallJob.inUse'), body: t('agentInstallJob.inUseBody'), kind: 'retry' } as const;
            case 'not_managed': return { title: t('agentInstallJob.manualInstall'), body: t('agentInstallJob.notManagedBody'), kind: 'guide' } as const;
            case 'consent_required': return { title: t('agentInstallJob.consentRequired'), body: t('agentInstallJob.consentBody'), kind: 'retry' } as const;
            case 'unsupported_platform': return { title: t('agentInstallJob.unsupportedPlatform'), body: t('agentInstallJob.unsupportedBody'), kind: 'chooseAgent' } as const;
            case 'install_not_available': return { title: t('agentInstallJob.manualInstall'), body: t('agentInstallJob.manualBody'), kind: 'guide' } as const;
            case 'update_not_available': return { title: t('agentInstallJob.updateUnavailable'), body: t('agentInstallJob.updateBody'), kind: 'guide' } as const;
            case 'archive_expanded_byte_limit': return { title: t('agentInstallJob.failed'), body: t('agentInstallJob.archiveExpandedByteLimitBody'), kind: 'retry' } as const;
            case 'download_failed': return { title: t('agentInstallJob.downloadFailed'),
                body: `${t('agentInstallJob.downloadBody')}${failure.failureCause?.errorCode ? ` (${failure.failureCause.errorCode})` : ''}`, kind: 'retry' } as const;
            case 'rate_limited': return { title: t('agentInstallJob.rateLimited'), body: rateLimitBody(failure.message), kind: 'retry' } as const;
            case 'verification_failed': return { title: t('agentInstallJob.verificationFailed'), body: t('agentInstallJob.verificationBody'), kind: 'retry' } as const;
            case 'timeout': return { title: t('agentInstallJob.timeout'), body: t('agentInstallJob.timeoutBody'), kind: 'retry' } as const;
            case 'cancelled': return { title: t('agentInstallJob.cancelled'), body: t('agentInstallJob.cancelledBody'), kind: 'retry' } as const;
            default: return { title: t('agentInstallJob.failed'), body: t('agentInstallJob.failedBody'), kind: 'retry' } as const;
        }
    })();
    const kind = copy.kind === 'guide' && !failure.guideUrl ? 'chooseAgent' : copy.kind;
    const label = kind === 'guide' ? t('agentInstallJob.openGuide')
        : kind === 'chooseAgent' ? t('agentInstallJob.chooseAgent') : t('agentInstallJob.retry');
    return { code: failure.code, title: copy.title, body: `${copy.body} ${t('machineAgents.failedKept')}`, recovery: { kind, label, ...(kind === 'guide' ? { guideUrl: failure.guideUrl } : {}) } };
}
