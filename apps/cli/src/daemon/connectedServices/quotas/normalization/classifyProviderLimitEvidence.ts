export { classifyProviderLimitEvidence } from '@happier-dev/plugin-sdk/connected-accounts';
import { classifyProviderLimitEvidence } from '@happier-dev/plugin-sdk/connected-accounts';

export type ProviderLimitCategory = ReturnType<typeof classifyProviderLimitEvidence>['category'];
