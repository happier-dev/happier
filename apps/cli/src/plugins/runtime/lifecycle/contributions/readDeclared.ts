import type {
    PluginActionContributionV2,
    ParsedPluginEventContributionV1,
    PluginRequestInterceptorContributionV1,
    PluginSystemToolContributionV1,
    PluginToolContributionV2,
    PluginCommandContributionV2,
} from '@happier-dev/protocol';

import type { PluginApiHostLifecycleHandlerDeclaration } from '../../api/types';
import { isRecord } from '../utils';

/**
 * Readers that pull a specific contribution shape off a raw (already schema
 * validated) plugin manifest `contributes` value. These back both the
 * bundled-plugin policy reader and the file-backed activation policy
 * resolver in `activation/policy.ts`.
 */

export function readDeclaredAgentIds(value: unknown): readonly string[] {
    return readDeclaredContributionIds(value, 'agents');
}

export function readDeclaredContributionIds(value: unknown, key: string): readonly string[] {
    if (!isRecord(value) || !Array.isArray(value[key])) {
        return Object.freeze([]);
    }
    return Object.freeze(value[key].flatMap((definition) => {
        if (!isRecord(definition)) {
            return [];
        }
        const id = typeof definition.id === 'string' ? definition.id.trim() : '';
        return id.length > 0 ? [id] : [];
    }));
}

export function readDeclaredEventContributions(value: unknown): readonly ParsedPluginEventContributionV1[] {
    if (!isRecord(value) || !Array.isArray(value.events)) {
        return Object.freeze([]);
    }
    return Object.freeze(value.events.flatMap((definition) => {
        if (!isRecord(definition)) {
            return [];
        }
        const id = typeof definition.id === 'string' ? definition.id.trim() : '';
        return id.length > 0 ? [definition as ParsedPluginEventContributionV1] : [];
    }));
}

export function readDeclaredActionContributions(value: unknown): readonly PluginActionContributionV2[] {
    if (!isRecord(value) || !Array.isArray(value.actions)) {
        return Object.freeze([]);
    }
    return Object.freeze(value.actions as PluginActionContributionV2[]);
}

export function readDeclaredToolContributions(value: unknown): readonly PluginToolContributionV2[] {
    if (!isRecord(value) || !Array.isArray(value.tools)) {
        return Object.freeze([]);
    }
    return Object.freeze(value.tools as PluginToolContributionV2[]);
}

export function readDeclaredCommandContributions(value: unknown): readonly PluginCommandContributionV2[] {
    if (!isRecord(value) || !Array.isArray(value.commands)) {
        return Object.freeze([]);
    }
    return Object.freeze(value.commands as PluginCommandContributionV2[]);
}

export function readDeclaredNestedContributionIds(value: unknown, parentKey: string, childKey: string): readonly string[] {
    if (!isRecord(value) || !isRecord(value[parentKey])) {
        return Object.freeze([]);
    }
    return readDeclaredContributionIds(value[parentKey], childKey);
}

export function readDeclaredRequestInterceptorContributions(value: unknown): readonly PluginRequestInterceptorContributionV1[] {
    if (!isRecord(value) || !Array.isArray(value.requestInterceptors)) {
        return Object.freeze([]);
    }
    return Object.freeze(value.requestInterceptors as PluginRequestInterceptorContributionV1[]);
}

export function readDeclaredSystemToolContributions(value: unknown): readonly PluginSystemToolContributionV1[] {
    if (!isRecord(value) || !Array.isArray(value.systemTools)) {
        return Object.freeze([]);
    }
    return Object.freeze(value.systemTools as PluginSystemToolContributionV1[]);
}

export function readDeclaredLifecycleHandlers(value: unknown): readonly PluginApiHostLifecycleHandlerDeclaration[] {
    if (!isRecord(value) || !Array.isArray(value.lifecycleHandlers)) {
        return Object.freeze([]);
    }
    return Object.freeze(value.lifecycleHandlers.flatMap((definition) => {
        const event = String(isRecord(definition) ? definition.event : '');
        if (!isRecord(definition) || !['activated', 'deactivating', 'deactivated'].includes(event)) {
            return [];
        }
        const id = typeof definition.id === 'string' && definition.id.trim().length > 0
            ? definition.id.trim()
            : null;
        if (id === null) {
            return [];
        }
        return [
            Object.freeze({
                id,
                event: event as PluginApiHostLifecycleHandlerDeclaration['event'],
            }),
        ];
    }));
}
