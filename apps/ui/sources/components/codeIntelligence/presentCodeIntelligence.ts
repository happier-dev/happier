import type {
  CodeIntelligenceActivityEventV1,
  CodeIntelligenceAnalysisProviderKindV1,
  CodeIntelligenceBillingClassV1,
  CodeIntelligenceChangedSymbolV1,
  CodeIntelligenceCommitAnalysisV1,
  CodeIntelligenceFindingSeverityV1,
  ObservedAgentSessionV1,
} from '@happier-dev/protocol';

import { AGENT_IDS, getAgentCore, type AgentId } from '@/agents/catalog/catalog';
import { t } from '@/text';

export function resolveObservedAgentId(providerId: string): AgentId | null {
  return (AGENT_IDS as readonly string[]).includes(providerId) ? (providerId as AgentId) : null;
}

export function formatAgentName(providerId: string): string {
  const agentId = resolveObservedAgentId(providerId);
  return agentId ? t(getAgentCore(agentId).displayNameKey) : providerId;
}

export function formatSessionStatus(status: ObservedAgentSessionV1['status']): string {
  switch (status) {
    case 'running': return t('codeIntelligence.status.running');
    case 'active_recently': return t('codeIntelligence.status.activeRecently');
    case 'idle': return t('codeIntelligence.status.idle');
    default: return t('codeIntelligence.status.unknown');
  }
}

export function formatAnalysisState(analysis: CodeIntelligenceCommitAnalysisV1): string {
  const status = (() => {
    switch (analysis.status) {
      case 'queued': return t('codeIntelligence.analysis.queued');
      case 'analyzing': return t('codeIntelligence.analysis.analyzing');
      case 'completed': return t('codeIntelligence.analysis.completed');
      case 'failed': return t('codeIntelligence.analysis.failed');
      case 'skipped': return t('codeIntelligence.analysis.skipped');
      default: return t('codeIntelligence.analysis.unverified');
    }
  })();
  if (analysis.status === 'completed') return `${status} · ${formatRisk(analysis.riskLevel)}`;
  return analysis.reason ? `${status} · ${formatAnalysisReason(analysis.reason)}` : status;
}

function formatAnalysisReason(reason: string): string {
  switch (reason) {
    case 'remote_analysis_disabled': return t('codeIntelligence.reason.remoteOff');
    case 'repository_not_allowed': return t('codeIntelligence.reason.repositoryNotAllowed');
    case 'no_eligible_provider': return t('codeIntelligence.reason.noProvider');
    case 'rate_limited': return t('codeIntelligence.reason.rateLimited');
    case 'invalid_model_output': return t('codeIntelligence.reason.invalidOutput');
    default: return t('codeIntelligence.reason.other');
  }
}

export function formatRisk(risk: CodeIntelligenceCommitAnalysisV1['riskLevel']): string {
  switch (risk) {
    case 'low': return t('codeIntelligence.risk.low');
    case 'medium': return t('codeIntelligence.risk.medium');
    case 'high': return t('codeIntelligence.risk.high');
    case 'critical': return t('codeIntelligence.risk.critical');
    default: return t('codeIntelligence.risk.unknown');
  }
}

function readString(event: CodeIntelligenceActivityEventV1, key: string): string {
  const value = event.data[key];
  return typeof value === 'string' && value.length > 0 ? value : '';
}

export function describeActivityEvent(event: CodeIntelligenceActivityEventV1): string {
  const branch = readString(event, 'branch') || readString(event, 'to') || t('codeIntelligence.detachedHead');
  switch (event.kind) {
    case 'repository_registered': return t('codeIntelligence.event.repositoryRegistered', { name: readString(event, 'displayName') });
    case 'worktree_observed': return t('codeIntelligence.event.worktreeObserved', { branch });
    case 'session_observed': return t('codeIntelligence.event.sessionObserved', { agent: formatAgentName(readString(event, 'providerId')) });
    case 'session_status_changed': return t('codeIntelligence.event.sessionStatusChanged', {
      agent: formatAgentName(readString(event, 'providerId')),
      status: formatSessionStatus(readString(event, 'status') as ObservedAgentSessionV1['status']),
    });
    case 'branch_changed': return t('codeIntelligence.event.branchChanged', { branch });
    case 'commit_observed': return t('codeIntelligence.event.commitObserved', { subject: readString(event, 'subject') });
    case 'analysis_started': return t('codeIntelligence.event.analysisStarted');
    case 'analysis_completed': return t('codeIntelligence.event.analysisCompleted', { findings: Number(event.data.findings ?? 0) });
    case 'analysis_failed': return t('codeIntelligence.event.analysisFailed');
    default: return t('codeIntelligence.event.analysisSkipped');
  }
}

/** Service names are proper nouns and are not translated. */
export const ANALYSIS_PROVIDER_BRANDS: Record<CodeIntelligenceAnalysisProviderKindV1, string> = {
  groq: 'Groq',
  openrouter: 'OpenRouter',
  opencode_zen: 'OpenCode Zen',
  opencode_go: 'OpenCode Go',
  openai_compatible: 'OpenAI-compatible',
};

export function formatBilling(billing: CodeIntelligenceBillingClassV1): string {
  switch (billing) {
    case 'free': return t('codeIntelligence.billing.free');
    case 'subscription': return t('codeIntelligence.billing.subscription');
    default: return t('codeIntelligence.billing.paid');
  }
}

export function formatChangeKind(changeKind: CodeIntelligenceChangedSymbolV1['changeKind']): string {
  switch (changeKind) {
    case 'added': return t('codeIntelligence.changeKind.added');
    case 'deleted': return t('codeIntelligence.changeKind.deleted');
    default: return t('codeIntelligence.changeKind.modified');
  }
}

export function formatSeverity(severity: CodeIntelligenceFindingSeverityV1): string {
  switch (severity) {
    case 'critical': return t('codeIntelligence.severity.critical');
    case 'high': return t('codeIntelligence.severity.high');
    case 'medium': return t('codeIntelligence.severity.medium');
    case 'low': return t('codeIntelligence.severity.low');
    default: return t('codeIntelligence.severity.info');
  }
}
