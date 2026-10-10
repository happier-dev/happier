import axios from 'axios';
import { executeAutomationSettingDeclaration } from '@happier-dev/protocol/actions';
import { AutomationV3SettingsUpdateRequestSchema,
    type AutomationV3Settings } from '@happier-dev/protocol/automations/automationApiV3';

import type { StoredCredentials } from '@/persistence';
import { normalizeServerHttpBaseUrl, resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

/** Direct adapter to the existing authenticated server-owned Automation policy record. */
export function createCliAutomationSettingsDeclarationAction(params: Readonly<{
    credentials: StoredCredentials;
    serverId?: string;
    serverHttpBaseUrl?: string;
    isCredentialCurrent?: () => boolean | Promise<boolean>;
}>) {
    return async (input: Readonly<{
        actionId: 'settings.get' | 'settings.set';
        anchor: string;
        field: keyof AutomationV3Settings;
        value?: unknown;
        signal?: AbortSignal;
    }>) => {
        const baseUrl = params.serverHttpBaseUrl ? normalizeServerHttpBaseUrl(params.serverHttpBaseUrl) : resolveServerHttpBaseUrl();
        const url = `${baseUrl}/v3/automations/settings`;
        const result = await executeAutomationSettingDeclaration({ ...input,
            isCurrent: () => params.isCredentialCurrent?.() ?? true,
            owner: {
                read: async () => {
                    const response = await axios.get<unknown>(url, {
                        headers: { Authorization: `Bearer ${params.credentials.token}` }, signal: input.signal,
                    });
                    return response.data;
                },
                write: async settings => {
                    const response = await axios.put<unknown>(url, AutomationV3SettingsUpdateRequestSchema.parse(settings), {
                        headers: { Authorization: `Bearer ${params.credentials.token}`, 'Content-Type': 'application/json' },
                        signal: input.signal,
                    });
                    return response.data;
                },
            },
        });
        return 'errorCode' in result && result.errorCode === 'setting_not_bound'
            ? { ok: false as const, errorCode: 'credential_scope_retired', error: 'credential_scope_retired' }
            : result;
    };
}
