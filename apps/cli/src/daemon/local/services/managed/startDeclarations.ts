import type {
    LocalServiceLaunchTargetV1,
    LocalServicePreviewInitialPathV1,
} from '@happier-dev/protocol';
import type { LocalServiceDeclarationV1 } from '@/plugins/runtime/exec/privateContract';

export type ManagedLocalServiceOwnerContext =
    | Readonly<{
        pluginId: string;
        contributionId: string;
        sessionId: string;
        operationId?: never;
        title: string;
        initialPath?: LocalServicePreviewInitialPathV1;
    }>
    | Readonly<{
        pluginId: string;
        contributionId: string;
        operationId: string;
        sessionId?: never;
        title: string;
        initialPath?: never;
    }>;

export function managedLocalServiceOwnerScopeKey(
    context: ManagedLocalServiceOwnerContext,
): string {
    return typeof context.sessionId === 'string'
        ? `session:${context.sessionId}`
        : `operation:${context.operationId}`;
}

export type ManagedLocalServiceStartDeclaration = Readonly<{
    serviceKey: string;
    targetId: string;
    machineId: string;
    context: ManagedLocalServiceOwnerContext;
    declaration: LocalServiceDeclarationV1;
    declaredAt: number;
}>;

export type ManagedLocalServiceStartDeclarationRegistry = Readonly<{
    declare(input: Readonly<{
        machineId: string;
        serviceKey: string;
        context: ManagedLocalServiceOwnerContext;
        declaration: LocalServiceDeclarationV1;
        declaredAt: number;
    }>): ManagedLocalServiceStartDeclaration;
    getByTargetId(targetId: string): ManagedLocalServiceStartDeclaration | null;
    getByServiceKey(serviceKey: string): ManagedLocalServiceStartDeclaration | null;
    removeByServiceKey(serviceKey: string): void;
    /**
     * Every declaration in one owner+session group (pluginId + contributionId + sessionId).
     * The assign-and-inject peer port plan is scoped to this group — never workspace-global.
     */
    listByOwnerSession(input: Readonly<{
        pluginId: string;
        contributionId: string;
        sessionId: string;
    }>): readonly ManagedLocalServiceStartDeclaration[];
    listByOwnerContext(
        context: ManagedLocalServiceOwnerContext,
    ): readonly ManagedLocalServiceStartDeclaration[];
    listLaunchTargets(input?: Readonly<{
        activeServiceIds?: ReadonlySet<string>;
        isStartable?: (declaration: ManagedLocalServiceStartDeclaration) => boolean;
    }>): readonly LocalServiceLaunchTargetV1[];
    clear(): void;
}>;

export function managedLocalServiceStartTargetId(serviceKey: string): string {
    return `managed:${serviceKey}`;
}

function declarationDisplayName(declaration: LocalServiceDeclarationV1): string {
    if (declaration.name.strategy === 'fixed') {
        return declaration.name.name;
    }
    return declaration.name.base;
}

function declarationConfidence(
    declaration: LocalServiceDeclarationV1,
): LocalServiceLaunchTargetV1['confidence'] {
    return declaration.launchMode.kind === 'detectAfterLaunch'
        ? declaration.launchMode.minimumConfidence ?? 'medium'
        : 'medium';
}

function targetFromDeclaration(
    declaration: ManagedLocalServiceStartDeclaration,
): LocalServiceLaunchTargetV1 | null {
    if (typeof declaration.context.sessionId !== 'string') {
        return null;
    }
    return {
        id: declaration.targetId,
        source: 'managed_service',
        sourceClass: {
            kind: 'managed_service',
            managedServiceId: declaration.serviceKey,
        },
        machineId: declaration.machineId,
        sessionId: declaration.context.sessionId,
        title: declaration.context.title,
        subtitle: declarationDisplayName(declaration.declaration),
        kind: 'managed_service',
        confidence: declarationConfidence(declaration.declaration),
        state: 'available',
        actions: ['start'],
    };
}

export function createManagedLocalServiceStartDeclarationRegistry(): ManagedLocalServiceStartDeclarationRegistry {
    const declarations = new Map<string, ManagedLocalServiceStartDeclaration>();

    return {
        declare(input) {
            const entry: ManagedLocalServiceStartDeclaration = Object.freeze({
                serviceKey: input.serviceKey,
                targetId: managedLocalServiceStartTargetId(input.serviceKey),
                machineId: input.machineId,
                context: input.context,
                declaration: input.declaration,
                declaredAt: input.declaredAt,
            });
            declarations.set(input.serviceKey, entry);
            return entry;
        },
        getByTargetId(targetId) {
            for (const declaration of declarations.values()) {
                if (declaration.targetId === targetId) {
                    return declaration;
                }
            }
            return null;
        },
        getByServiceKey(serviceKey) {
            return declarations.get(serviceKey) ?? null;
        },
        removeByServiceKey(serviceKey) {
            declarations.delete(serviceKey);
        },
        listByOwnerSession(input) {
            const out: ManagedLocalServiceStartDeclaration[] = [];
            for (const declaration of declarations.values()) {
                if (
                    declaration.context.pluginId === input.pluginId
                    && declaration.context.contributionId === input.contributionId
                    && declaration.context.sessionId === input.sessionId
                ) {
                    out.push(declaration);
                }
            }
            return out;
        },
        listByOwnerContext(context) {
            const ownerScopeKey = managedLocalServiceOwnerScopeKey(context);
            const out: ManagedLocalServiceStartDeclaration[] = [];
            for (const declaration of declarations.values()) {
                if (
                    declaration.context.pluginId === context.pluginId
                    && declaration.context.contributionId === context.contributionId
                    && managedLocalServiceOwnerScopeKey(declaration.context) === ownerScopeKey
                ) {
                    out.push(declaration);
                }
            }
            return out;
        },
        listLaunchTargets(input = {}) {
            const activeServiceIds = input.activeServiceIds ?? new Set<string>();
            const out: LocalServiceLaunchTargetV1[] = [];
            for (const declaration of declarations.values()) {
                if (activeServiceIds.has(declaration.serviceKey)) {
                    continue;
                }
                if (input.isStartable && !input.isStartable(declaration)) {
                    continue;
                }
                const target = targetFromDeclaration(declaration);
                if (target) {
                    out.push(target);
                }
            }
            return out;
        },
        clear() {
            declarations.clear();
        },
    };
}
