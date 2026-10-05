import { ApiTokensSettingsLayout } from '@/components/settings/apiTokens/collection/ApiTokensSettingsLayout';
import { createSettingsLayoutRoute } from '@/components/settings/navigation/createSettingsLayoutRoute';

export default createSettingsLayoutRoute(ApiTokensSettingsLayout, 'account/api-tokens');
