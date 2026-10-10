import type { HappierInputPickerOption } from '@happier-dev/plugin-ui/presentation';
import type { PromptArtifactRefV1 } from '@happier-dev/protocol/prompts/library/promptArtifactRefsV1';
import { PromptBundleSchemaIdV1Schema } from '@happier-dev/protocol/prompts/library/promptBundleSchemas';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { isPromptLibraryReferenceInHome } from '@/sync/ops/promptLibrary/promptLibraryReferences';

export type PromptStackEntryPresentation = Readonly<{
    kind: 'memory' | 'doc' | 'skill' | 'unknown';
    title: string | null;
    headerKind: string | null;
    access: NonNullable<DecryptedArtifact['access']> | null;
}>;
export const UNKNOWN_PROMPT_STACK_PRESENTATION: PromptStackEntryPresentation = Object.freeze({ kind: 'unknown', title: null, headerKind: null, access: null });

/** The one header classification consumed by Context rows and document options. */
export function promptStackArtifactPresentation(header: Readonly<Record<string, unknown>> | null | undefined,
    access?: DecryptedArtifact['access']): PromptStackEntryPresentation {
    const kind = header?.kind === 'memory_doc.v1' ? 'memory' : header?.kind === 'prompt_doc.v2' ? 'doc'
        : header?.kind === 'prompt_bundle.v2' && PromptBundleSchemaIdV1Schema.safeParse(header.bundleSchemaId).success ? 'skill' : 'unknown';
    return kind === 'unknown' ? UNKNOWN_PROMPT_STACK_PRESENTATION : { kind, headerKind: String(header?.kind),
        title: typeof header?.title === 'string' && header.title ? header.title : null, access: access ?? null };
}

export type PromptStackDocumentChoice = HappierInputPickerOption & Readonly<{
    id: string;
    value: PromptArtifactRefV1;
    kind: Exclude<PromptStackEntryPresentation['kind'], 'unknown'>;
}>;

/** The host supplies an admitted Account inventory and its actual Home, never a requested alias. */
export function promptStackDocumentChoices(input: Readonly<{
    artifacts: readonly DecryptedArtifact[];
    serverId: string;
    attachedRefs: readonly PromptArtifactRefV1[];
    untitled: string;
    purpose?: 'context' | 'instructions';
}>): readonly PromptStackDocumentChoice[] {
    return input.artifacts.flatMap(artifact => {
        if (artifact.isDecrypted === false || input.attachedRefs.some(ref => isPromptLibraryReferenceInHome(ref, artifact.id, input.serverId))) return [];
        const presentation = promptStackArtifactPresentation(artifact.header, artifact.access);
        if (presentation.kind === 'unknown' || (input.purpose === 'instructions' && presentation.kind !== 'doc')) return [];
        return [{ id: artifact.id, value: { kind: presentation.kind === 'skill' ? 'bundle' as const : 'doc' as const,
            artifactId: artifact.id, serverId: input.serverId }, kind: presentation.kind,
            label: presentation.title ?? input.untitled }];
    });
}
