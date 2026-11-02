/** @moduleRealm any */
import type { JsonValue, PluginJsonSchemaV2, PreparedPluginJsonSchema, RehydratedPluginContributionPointOperationV1, RehydratedPluginContributionPointSurfaceV1 } from '@happier-dev/protocol';
import type { TargetedContributionRendererDeclaration } from './targetedContributionAdmission.js';

export type AdmittedTargetedContributionContributor<TOccurrence extends string = string> = Readonly<{
    pluginId: string;
    contributionId: string;
    occurrenceId: TOccurrence;
}>;

/**
 * Host-private summary of the exact input selection the target-scoped UI
 * admits for one Action. It carries no selected Account value: that remains
 * only in the transient UI settlement.
 */
export type AdmittedTargetedContributionActionInputSelection = Readonly<
    | { kind: 'none' }
    | { kind: 'connectedAccount'; fieldPath: string }
    | { kind: 'unavailable' }
>;

export type AdmittedTargetedContributionOperation<TOccurrence extends string = string> = Readonly<{
    role: string;
    action: Readonly<{
        pluginId: string;
        localId: string;
    }>;
    /** Exact parent contributor identity, retained for independent role projection. */
    contributor: AdmittedTargetedContributionContributor<TOccurrence>;
    /** Current physical source cannot admit this declared role; no handler may begin. */
    unavailable?: true;
    /**
     * Current Action-definition selection fact retained only for the opaque
     * admitted-operation execution handle. It never crosses the public
     * targeted-contribution projection.
     */
    selectedActionInput: AdmittedTargetedContributionActionInputSelection;
    /** Exact target-owned parser pair retained only in the opaque Action handle binding. */
    targetProtocol: RehydratedPluginContributionPointOperationV1;
}>;

/**
 * Host-private resolved renderer chain for an admitted embedded surface.
 * UI projection must consume this exact chain; it must not re-search the
 * global renderer catalog by local ID.
 */
export type AdmittedTargetedContributionSurface<TRenderer extends TargetedContributionRendererDeclaration = TargetedContributionRendererDeclaration, TOccurrence extends string = string> = Readonly<{
    role: string;
    /** Exact target-owned role contract for the UI mount projection; not public SDK data. */
    inputSchema: PluginJsonSchemaV2;
    /**
     * Exact normalized schema and one compiled validator owned by cold target
     * admission for this contributor generation. It never crosses RPC.
     */
    inputValidation: PreparedPluginJsonSchema;
    /** Exact target-owned parser retained by cold admission, never projected over RPC. */
    targetProtocol: RehydratedPluginContributionPointSurfaceV1;
    presentation: 'content' | 'fill';
    rendererChain: readonly TRenderer[];
    /** Exact parent contributor identity, retained for independent surface projection. */
    contributor: AdmittedTargetedContributionContributor<TOccurrence>;
}>;

export type AdmittedTargetedContribution<TRenderer extends TargetedContributionRendererDeclaration = TargetedContributionRendererDeclaration, TOccurrence extends string = string> = Readonly<{
    contributor: AdmittedTargetedContributionContributor<TOccurrence>;
    protocol: Readonly<{
        id: string;
        version: number;
    }>;
    descriptor?: JsonValue;
    operations: readonly AdmittedTargetedContributionOperation<TOccurrence>[];
    surfaces: readonly AdmittedTargetedContributionSurface<TRenderer, TOccurrence>[];
}>;

export type AdmittedTargetedContributionSnapshot<TRenderer extends TargetedContributionRendererDeclaration = TargetedContributionRendererDeclaration, TOccurrence extends string = string> = Readonly<{
    target: Readonly<{
        pluginId: string;
        pointId: string;
        occurrenceId: TOccurrence;
    }>;
    contributions: readonly AdmittedTargetedContribution<TRenderer, TOccurrence>[];
}>;
