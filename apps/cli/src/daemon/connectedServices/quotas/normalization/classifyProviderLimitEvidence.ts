export { classifyProviderLimitEvidence } from '@happier-dev/plugin-sdk/first-party/connected-accounts';
import { classifyProviderLimitEvidence } from '@happier-dev/plugin-sdk/first-party/connected-accounts';

export type ProviderLimitCategory = ReturnType<typeof classifyProviderLimitEvidence>['category'];
