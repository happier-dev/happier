import type { ConnectedServiceQuotaFetcherDescriptor } from '@/daemon/connectedServices/quotas/types';
import { claudeSubscriptionQuotaFetcherDescriptor } from '@happier-dev/plugins-claude/agent/auth/services/quota/subscriptionFetcher';
import { openAiCodexQuotaFetcherDescriptor } from '@happier-dev/plugins-codex/agent/auth/services/quota/openaiFetcher';
import { geminiConnectedServiceQuotaFetcherContribution } from '@happier-dev/plugins-gemini';

export const connectedServiceQuotaFetcherDescriptors = [
  openAiCodexQuotaFetcherDescriptor,
  claudeSubscriptionQuotaFetcherDescriptor,
  geminiConnectedServiceQuotaFetcherContribution,
] satisfies readonly ConnectedServiceQuotaFetcherDescriptor[];
