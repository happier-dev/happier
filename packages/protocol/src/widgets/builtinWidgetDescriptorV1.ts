import type { InputHints } from '../inputs/inputFields.js';
import type { WidgetInputDescriptorV1 } from './widgetInputAdmissionV1.js';
import type { WidgetDefinitionRefV1, WidgetInstanceV1 } from './widgetInstanceV1.js';
import { sameStrictJsonValue } from '../json/strictJsonValue.js';
import type { WidgetSizeDeclarationV1 } from './widgetPresentationV1.js';

/** Native Session content identities; presentation references and configured copies share this owner. */
export const SESSION_COMPANION_BUILTIN_ITEM_IDS = ['session_summary', 'agent_plan', 'changes', 'local_services'] as const;
export type BuiltinWidgetIdV1 = (typeof SESSION_COMPANION_BUILTIN_ITEM_IDS)[number];

const nativeMetadata = {
    session_summary: { title: 'Session summary', titleKey: 'sessionBoard.companion.summary.title', icon: 'stack' },
    agent_plan: { title: 'Agent plan', titleKey: 'sessionCompanion.plan.title', icon: 'list-checks' },
    changes: { title: 'Changes', titleKey: 'widgetGlances.changesTitle', icon: 'git-branch' },
    local_services: { title: 'Local services', titleKey: 'widgetGlances.localServicesTitle', icon: 'hard-drives' },
} as const;

const inputs: InputHints = { fields: [{ path: 'session', title: 'Session', description: 'The session it shows; it reads that session where it runs.', widget: 'json', required: true, optionsSourceId: 'sessions' }] };
const sessionInputs: WidgetInputDescriptorV1 = {
    inputs,
    sessionInputPath: 'session',
    inputSchema: { type: 'object', properties: { session: { type: 'object', properties: {
        serverId: { type: 'string', minLength: 1 }, sessionId: { type: 'string', minLength: 1 },
    }, required: ['serverId', 'sessionId'], additionalProperties: false } }, required: ['session'], additionalProperties: false },
};
const nativeSizeDeclaration = { sizes: ['small', 'medium', 'wide', 'full', 'tall', 'large'], defaultSize: 'medium' } satisfies WidgetSizeDeclarationV1;

/** Descriptor projection only: execution, data and Actions stay with the existing native domains. */
type NativeDescriptor = WidgetInputDescriptorV1 & Readonly<{
    sizeDeclaration: WidgetSizeDeclarationV1;
    definition: Readonly<{ kind: 'builtin'; id: BuiltinWidgetIdV1 }>;
    surface?: never;
    title: string; titleKey: (typeof nativeMetadata)[BuiltinWidgetIdV1]['titleKey'];
    icon: (typeof nativeMetadata)[BuiltinWidgetIdV1]['icon'];
    key: string; target: 'session'; homeDefault: 'available'; availability: 'available';
}>;
export const BUILTIN_WIDGET_DESCRIPTORS_V1 = Object.freeze(SESSION_COMPANION_BUILTIN_ITEM_IDS.map((id): NativeDescriptor => Object.freeze({
    ...sessionInputs, ...nativeMetadata[id], definition: { kind: 'builtin' as const, id },
    sizeDeclaration: nativeSizeDeclaration,
    key: `builtin:${id}`, target: 'session' as const, homeDefault: 'available' as const, availability: 'available' as const,
})));
export type BuiltinWidgetDescriptorV1 = NativeDescriptor;

export function readBuiltinWidgetDescriptorV1(definition: WidgetDefinitionRefV1): BuiltinWidgetDescriptorV1 | null {
    return definition.kind === 'builtin' ? BUILTIN_WIDGET_DESCRIPTORS_V1.find(row => row.definition.id === definition.id) ?? null : null;
}

export type WidgetCandidateIdentityV1 = Readonly<{ surface: Extract<WidgetDefinitionRefV1, { kind: 'installed' }>['surface']; definition?: never }>
    | Readonly<{ definition: Exclude<WidgetDefinitionRefV1, { kind: 'installed' }>; surface?: never }>;

export function widgetCandidateDefinitionV1(candidate: WidgetCandidateIdentityV1): WidgetDefinitionRefV1 {
    return candidate.surface ? { kind: 'installed', surface: candidate.surface } : candidate.definition;
}

export function isSameWidgetDefinitionV1(left: WidgetDefinitionRefV1, right: WidgetDefinitionRefV1): boolean {
    if (left.kind !== right.kind) return false;
    if (left.kind === 'builtin' && right.kind === 'builtin') return left.id === right.id;
    if (left.kind === 'artifact' && right.kind === 'artifact') return left.artifactId === right.artifactId;
    if (left.kind === 'inline' && right.kind === 'inline') return sameStrictJsonValue(left.definition, right.definition);
    return left.kind === 'installed' && right.kind === 'installed'
        && left.surface.pluginId === right.surface.pluginId && left.surface.localId === right.surface.localId;
}

/** Gallery copies include explicit shared publications; the Artifact reader enforces id = artifactId. */
export function countWidgetInstancesV1(instances: Iterable<Pick<WidgetInstanceV1, 'definition'>>, definition: WidgetDefinitionRefV1): number {
    let count = 0;
    for (const instance of instances) {
        if (isSameWidgetDefinitionV1(instance.definition, definition)
            || (definition.kind === 'artifact' && instance.definition.kind === 'inline' && instance.definition.definition.id === definition.artifactId)) count += 1;
    }
    return count;
}
