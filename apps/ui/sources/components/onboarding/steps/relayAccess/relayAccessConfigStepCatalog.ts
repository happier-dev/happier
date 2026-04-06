import type { RelayAccessConfig } from '@happier-dev/cli-common/relayAccess/catalog';
import type { RelayAccessTaskSnapshot } from '@happier-dev/cli-common/systemTasks';

import { Modal } from '@/modal';
import { t } from '@/text';

export type RelayAccessConfigStepFieldId = 'url' | 'hostname' | 'token';
export type RelayAccessConfigStepProviderId = 'lan' | 'cloudflareNamed';
export type RelayAccessConfigStepDraft = Readonly<Record<RelayAccessConfigStepFieldId, string>>;

export type RelayAccessConfigStepField = Readonly<{
    id: RelayAccessConfigStepFieldId;
    label: string;
    placeholder: string;
    secureTextEntry?: boolean;
    autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
    autoCorrect?: boolean;
}>;

export type RelayAccessConfigStepDefinition = Readonly<{
    providerId: RelayAccessConfigStepProviderId;
    testIDPrefix: string;
    fields: readonly RelayAccessConfigStepField[];
    hint: string;
    readConfiguredDraft: (snapshot: RelayAccessTaskSnapshot | null) => RelayAccessConfigStepDraft;
    normalizeDraft: (draft: RelayAccessConfigStepDraft) => RelayAccessConfigStepDraft;
    isSaveNeeded: (params: Readonly<{
        configuredDraft: RelayAccessConfigStepDraft;
        normalizedDraft: RelayAccessConfigStepDraft;
    }>) => boolean;
    isPrimaryDisabled: (params: Readonly<{
        needsSave: boolean;
        normalizedDraft: RelayAccessConfigStepDraft;
    }>) => boolean;
    createConfig: (params: Readonly<{
        normalizedDraft: RelayAccessConfigStepDraft;
    }>) => Promise<RelayAccessConfig | null>;
}>;

const EMPTY_DRAFT: RelayAccessConfigStepDraft = Object.freeze({
    url: '',
    hostname: '',
    token: '',
});

function createEmptyDraft(): RelayAccessConfigStepDraft {
    return {
        ...EMPTY_DRAFT,
    };
}

function normalizeUrl(value: string): string {
    return value.trim().replace(/\/+$/, '');
}

function normalizeHostname(value: string): string {
    return value.trim();
}

function normalizeToken(value: string): string {
    return value.trim();
}

async function createLanConfig(normalizedDraft: RelayAccessConfigStepDraft): Promise<RelayAccessConfig | null> {
    if (!normalizedDraft.url) {
        await Modal.alert(t('common.error'), t('settings.relayAccess.missingUrl'));
        return null;
    }

    return {
        providerId: 'lan',
        url: normalizedDraft.url,
    };
}

async function createCloudflareConfig(normalizedDraft: RelayAccessConfigStepDraft): Promise<RelayAccessConfig | null> {
    if (!normalizedDraft.hostname) {
        await Modal.alert(t('common.error'), t('settings.relayAccess.missingHostname'));
        return null;
    }
    if (!normalizedDraft.token) {
        await Modal.alert(t('common.error'), t('settings.relayAccess.missingToken'));
        return null;
    }

    return {
        providerId: 'cloudflareNamed',
        hostname: normalizedDraft.hostname,
        token: normalizedDraft.token,
    };
}

export const relayAccessConfigStepCatalog: Readonly<Record<RelayAccessConfigStepProviderId, RelayAccessConfigStepDefinition>> = {
    lan: {
        providerId: 'lan',
        testIDPrefix: 'relay-access-lan',
        fields: [
            {
                id: 'url',
                label: t('settings.relayAccess.fields.urlLabel'),
                placeholder: t('common.urlPlaceholder'),
                autoCapitalize: 'none',
                autoCorrect: false,
            },
        ],
        hint: t('setupOnboarding.relayAccessUrlBody'),
        readConfiguredDraft: (snapshot) => {
            if (snapshot?.configured !== true || snapshot.providerId !== 'lan') {
                return createEmptyDraft();
            }

            return {
                ...createEmptyDraft(),
                url: typeof snapshot.status?.shareUrl === 'string'
                    ? normalizeUrl(snapshot.status.shareUrl)
                    : '',
            };
        },
        normalizeDraft: (draft) => ({
            ...createEmptyDraft(),
            url: normalizeUrl(draft.url),
        }),
        isSaveNeeded: ({ configuredDraft, normalizedDraft }) => configuredDraft.url.length === 0 || normalizedDraft.url !== configuredDraft.url,
        isPrimaryDisabled: ({ needsSave, normalizedDraft }) => needsSave && normalizedDraft.url.length === 0,
        createConfig: async ({ normalizedDraft }) => await createLanConfig(normalizedDraft),
    },
    cloudflareNamed: {
        providerId: 'cloudflareNamed',
        testIDPrefix: 'relay-access-cloudflare',
        fields: [
            {
                id: 'hostname',
                label: t('settings.relayAccess.fields.hostnameLabel'),
                placeholder: t('settings.relayAccess.fields.hostnameLabel'),
                autoCapitalize: 'none',
                autoCorrect: false,
            },
            {
                id: 'token',
                label: t('settings.relayAccess.fields.tokenLabel'),
                placeholder: t('settings.relayAccess.fields.tokenLabel'),
                autoCapitalize: 'none',
                autoCorrect: false,
                secureTextEntry: true,
            },
        ],
        hint: t('setupOnboarding.relayAccessCloudflareBody'),
        readConfiguredDraft: (snapshot) => {
            if (snapshot?.configured !== true || snapshot.providerId !== 'cloudflareNamed') {
                return createEmptyDraft();
            }

            const shareUrl = typeof snapshot.status?.shareUrl === 'string' ? snapshot.status.shareUrl.trim() : '';
            let hostname = '';
            if (shareUrl) {
                try {
                    hostname = new URL(shareUrl).hostname;
                } catch {
                    hostname = '';
                }
            }

            return {
                ...createEmptyDraft(),
                hostname,
            };
        },
        normalizeDraft: (draft) => ({
            ...createEmptyDraft(),
            hostname: normalizeHostname(draft.hostname),
            token: normalizeToken(draft.token),
        }),
        isSaveNeeded: ({ configuredDraft, normalizedDraft }) => (
            configuredDraft.hostname.length === 0
            || normalizedDraft.hostname !== configuredDraft.hostname
            || normalizedDraft.token.length > 0
        ),
        isPrimaryDisabled: ({ needsSave, normalizedDraft }) => (
            needsSave && (normalizedDraft.hostname.length === 0 || normalizedDraft.token.length === 0)
        ),
        createConfig: async ({ normalizedDraft }) => await createCloudflareConfig(normalizedDraft),
    },
};
