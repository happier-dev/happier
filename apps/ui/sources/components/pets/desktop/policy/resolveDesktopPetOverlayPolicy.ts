import type { z } from 'zod';

import {
    DesktopPetOverlayAnchorSchema,
    DesktopPetOverlayVisibilityModeOverrideSchema,
} from '@/sync/domains/settings/registry/local/localSettingDefinitions';
import { AccountPetDesktopOverlayVisibilityModeSchema } from '@/sync/domains/settings/registry/account/accountPetSettingDefinitions';

export type DesktopPetOverlayFeatureState = 'enabled' | 'disabled' | 'unknown';
export type DesktopPetOverlayVisibilityMode = z.infer<typeof AccountPetDesktopOverlayVisibilityModeSchema>;
export type DesktopPetOverlayAnchor = z.infer<typeof DesktopPetOverlayAnchorSchema>;

export type DesktopPetOverlayPolicyInput = Readonly<{
    companionFeatureState: DesktopPetOverlayFeatureState;
    accountSettings?: Readonly<Record<string, unknown>>;
    localSettings?: Readonly<Record<string, unknown>>;
}>;

export type DesktopPetOverlayPolicy = Readonly<{
    enabled: boolean;
    visibilityMode: DesktopPetOverlayVisibilityMode;
    alwaysOnTop: boolean;
    inputLocked: boolean;
    anchor: DesktopPetOverlayAnchor;
}>;

const VISIBILITY_MODES = AccountPetDesktopOverlayVisibilityModeSchema.options;
const VISIBILITY_MODE_OVERRIDES = DesktopPetOverlayVisibilityModeOverrideSchema.options;
const ANCHORS = DesktopPetOverlayAnchorSchema.options;

function readRecord(value: unknown): Readonly<Record<string, unknown>> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>>
        : {};
}

function readBoolean(value: unknown, fallback: boolean): boolean {
    return typeof value === 'boolean' ? value : fallback;
}

function readEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
    return typeof value === 'string' && allowed.includes(value as T) ? value as T : fallback;
}

function readOverride(
    value: unknown,
    inherited: boolean,
): boolean {
    if (value === 'enabled') {
        return true;
    }
    if (value === 'disabled') {
        return false;
    }
    return inherited;
}

export function resolveDesktopPetOverlayPolicy(
    input: DesktopPetOverlayPolicyInput,
): DesktopPetOverlayPolicy {
    const accountSettings = readRecord(input.accountSettings);
    const localSettings = readRecord(input.localSettings);
    const accountPetsEnabled = readBoolean(accountSettings.petsEnabled, false);
    const petsEnabled = readOverride(localSettings.petsEnabledOverride, accountPetsEnabled);
    const accountOverlayEnabled = readBoolean(accountSettings.petsDesktopOverlayDefaultEnabled, false);
    const overlayEnabled = readOverride(
        localSettings.desktopPetOverlayEnabledOverride,
        accountOverlayEnabled,
    );
    const accountVisibilityMode = readEnum(
        accountSettings.petsDesktopOverlayDefaultVisibilityMode,
        VISIBILITY_MODES,
        'alwaysWhenEnabled',
    );
    const localVisibilityModeOverride = readEnum(
        localSettings.desktopPetOverlayVisibilityModeOverride,
        VISIBILITY_MODE_OVERRIDES,
        'inherit',
    );
    const visibilityMode = localVisibilityModeOverride === 'inherit'
        ? accountVisibilityMode
        : localVisibilityModeOverride;

    return {
        enabled: input.companionFeatureState === 'enabled' && petsEnabled && overlayEnabled,
        visibilityMode,
        alwaysOnTop: true,
        inputLocked: readBoolean(localSettings.desktopPetOverlayLocked, false),
        anchor: readEnum(localSettings.desktopPetOverlayAnchor, ANCHORS, 'bottomRight'),
    };
}
