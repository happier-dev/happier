import {
    readPluginSettingManagedServiceOrigin,
    readPluginSettingSecretCustody,
} from '@happier-dev/protocol';
import { PluginError } from '@happier-dev/plugin-sdk';

import { notificationChannelSettingFieldId } from '@/plugins/settings/notificationChannelSettings';

import type { DeclaredPluginSecret } from './secrets';

export type PluginSecretDeclaration = Readonly<{
    pluginId: string;
    declaration: DeclaredPluginSecret;
}>;

type SecretBearingManifest = Readonly<{
    secrets?: readonly Readonly<{
        id: string;
        custody?: 'account' | 'daemon';
    }>[];
    contributes: Readonly<{
        settings?: readonly Readonly<{
            fields: readonly Readonly<{
                id: string;
                secret?: unknown;
            }>[];
        }>[];
        notificationChannels?: readonly Readonly<{
            id: string;
            settings?: readonly Readonly<{
                id: string;
                secret?: unknown;
            }>[];
        }>[];
    }>;
}>;

/**
 * Canonically projects every manifest-declared secret identifier before a
 * runtime consumer binds custody. This stays independent of daemon activation:
 * a declaration is an immutable manifest fact, not an activation side effect.
 */
export function collectDeclaredPluginSecrets(
    manifests: readonly Readonly<{
        pluginId: string;
        manifest: SecretBearingManifest;
    }>[],
    options?: Readonly<{
        /**
         * Quarantines a contested secret id instead of aborting the whole
         * collection, and reports which plugin lost it. Callers that collect
         * across every plugin must pass this: without it one plugin's
         * contradictory manifest denies every other plugin its declared
         * secrets. Callers scoped to a single plugin omit it so the precise
         * authoring error still surfaces.
         */
        onSecretDeclarationRefused(input: Readonly<{ pluginId: string; secretId: string }>): void;
    }>,
): readonly PluginSecretDeclaration[] {
    const declarations = new Map<string, PluginSecretDeclaration>();
    const refusedKeys = new Set<string>();
    for (const { pluginId, manifest } of manifests) {
        const add = (
            id: string,
            custody: 'account' | 'daemon',
            managedServiceOrigin?: DeclaredPluginSecret['managedServiceOrigin'],
        ): void => {
            const key = `${pluginId}\u0000${id}`;
            // A contested id stays refused for every later declaration of it, so
            // custody can never be decided by manifest declaration order.
            if (refusedKeys.has(key)) return;
            const declaration = Object.freeze({
                pluginId,
                declaration: Object.freeze({
                    id,
                    custody,
                    ...(managedServiceOrigin
                        ? {
                            managedServiceOrigin: Object.freeze({
                                endpointSettingId: managedServiceOrigin.endpointSettingId,
                            }),
                        }
                        : {}),
                }),
            });
            const existing = declarations.get(key);
            if (
                existing
                && (
                    existing.declaration.custody !== declaration.declaration.custody
                    || existing.declaration.managedServiceOrigin?.endpointSettingId
                        !== declaration.declaration.managedServiceOrigin?.endpointSettingId
                )
            ) {
                if (!options?.onSecretDeclarationRefused) {
                    throw new PluginError({
                        code: 'plugin_secret_declaration_invalid',
                        message: `Plugin secret '${id}' has conflicting custody or origin declarations`,
                    });
                }
                // Contradictory custody for one id is an authoring defect in this
                // plugin alone. Admitting either claimant would bind the secret to
                // an unintended custody, so both are refused; every other plugin
                // and this plugin's coherent declarations survive.
                refusedKeys.add(key);
                declarations.delete(key);
                options.onSecretDeclarationRefused({ pluginId, secretId: id });
                return;
            }
            declarations.set(key, declaration);
        };
        for (const secret of manifest.secrets ?? []) {
            add(secret.id, secret.custody ?? 'account');
        }
        for (const contribution of manifest.contributes.settings ?? []) {
            for (const field of contribution.fields) {
                const custody = readPluginSettingSecretCustody(field.secret);
                if (custody) {
                    add(
                        field.id,
                        custody,
                        readPluginSettingManagedServiceOrigin(field.secret) ?? undefined,
                    );
                }
            }
        }
        for (const channel of manifest.contributes.notificationChannels ?? []) {
            for (const field of channel.settings ?? []) {
                const custody = readPluginSettingSecretCustody(field.secret);
                if (custody) {
                    add(notificationChannelSettingFieldId(channel.id, field.id), custody);
                }
            }
        }
    }
    return Object.freeze([...declarations.values()]);
}
