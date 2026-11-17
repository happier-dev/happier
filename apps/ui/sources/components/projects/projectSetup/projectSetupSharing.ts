import { ProjectManifestV1Schema, type ProjectManifestV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestV1';
import type { ArtifactActionResultV1 } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import type { ProjectSourceV1, ProjectSourcePublicationPatchV1, ProjectSourcesFailureV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { readActionErrorCodeV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ProjectManifestActionClient } from './projectManifestActionClient';
import { readProjectEffectiveDefinition } from './projectEffectiveDefinition';

export type ProjectSetupShareSelection = Readonly<{
    sections: readonly Exclude<keyof ProjectManifestV1, 'version' | 'scripts' | 'services'>[];
    scripts: readonly string[];
    services: readonly string[];
}>;
export type ProjectSetupSharePreview = Readonly<{ manifest: ProjectManifestV1; bytes: string }>;
type Publication = ArtifactActionResultV1<'artifact.create'>;
export type ProjectSetupShareTarget = Readonly<{
    sourceId: string; expectedRevision: number; title: string; patch?: ProjectSourcePublicationPatchV1;
}>;
export type ProjectSetupShareResult =
    | Readonly<{ kind: 'warningRequired' }>
    | Readonly<{ kind: 'unavailable'; code: string }>
    | Readonly<{ kind: 'attached'; publication: Publication; source: ProjectSourceV1 }>
    | Readonly<{ kind: 'savedNotAttached'; publication: Publication; code: string; refusal?: ProjectSourcesFailureV1 }>;
export type ProjectSetupSharingSnapshot = Readonly<{
    status: 'initial' | 'loading' | 'ready' | 'unavailable';
    manifest: ProjectManifestV1 | null;
    selection: ProjectSetupShareSelection | null;
    preview: ProjectSetupSharePreview | null;
    warningAcknowledged: boolean;
    publication: Publication | null;
    pending: boolean;
    issue: string | null;
}>;

/** Select declarations, never runtime assignments, private binding values, or unknown author fields. */
export function selectProjectSetupShareManifest(manifest: ProjectManifestV1, selection: ProjectSetupShareSelection): ProjectManifestV1 {
    const selectedEntries = (field: 'scripts' | 'services', names: readonly string[]) => Object.fromEntries(
        names.flatMap(name => manifest[field] && Object.hasOwn(manifest[field], name) ? [[name, manifest[field][name]]] : []));
    return ProjectManifestV1Schema.parse({ version: 1,
        ...Object.fromEntries(selection.sections.flatMap(field => manifest[field] !== undefined ? [[field, manifest[field]]] : [])),
        ...(selection.scripts.length ? { scripts: selectedEntries('scripts', selection.scripts) } : {}),
        ...(selection.services.length ? { services: selectedEntries('services', selection.services) } : {}),
    });
}
function allSelection(manifest: ProjectManifestV1): ProjectSetupShareSelection {
    return { sections: (Object.keys(manifest) as Array<keyof ProjectManifestV1>)
        .filter((key): key is ProjectSetupShareSelection['sections'][number] => key !== 'version' && key !== 'scripts' && key !== 'services'),
        scripts: Object.keys(manifest.scripts ?? {}), services: Object.keys(manifest.services ?? {}) };
}
function preview(manifest: ProjectManifestV1, selection: ProjectSetupShareSelection): ProjectSetupSharePreview {
    const selected = selectProjectSetupShareManifest(manifest, selection);
    return { manifest: selected, bytes: `${JSON.stringify(selected, null, 2)}\n` };
}

/** Ephemeral sharing draft. The existing Artifact and Source Actions retain every custody/sharing decision. */
export function createProjectSetupSharing(input: Readonly<{ client: ProjectManifestActionClient }>) {
    const initial: ProjectSetupSharingSnapshot = { status: 'initial', manifest: null, selection: null, preview: null,
        warningAcknowledged: false, publication: null, pending: false, issue: null };
    let state = initial;
    let active = true;
    let loading: Promise<void> | null = null;
    let publishing: Promise<ProjectSetupShareResult> | null = null;
    const listeners = new Set<() => void>();
    const publish = (next: ProjectSetupSharingSnapshot) => { if (active) { state = next; for (const listener of listeners) listener(); } };
    const select = (selection: ProjectSetupShareSelection) => {
        if (!state.manifest || state.pending) return;
        const next = preview(state.manifest, selection);
        if (state.preview?.bytes === next.bytes) return;
        publish({ ...state, selection, preview: next, publication: null, warningAcknowledged: false, issue: null });
    };
    return {
        getSnapshot: () => state,
        subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        dispose() { active = false; state = initial; for (const listener of listeners) listener(); listeners.clear(); },
        load(): Promise<void> {
            if (loading) return loading;
            if (!active || state.pending) return Promise.resolve();
            publish({ ...state, status: 'loading', issue: null });
            loading = (async () => {
                try {
                    const inspected = await input.client.inspect({ kind: 'editor' });
                    const effective = readProjectEffectiveDefinition(inspected);
                    if (effective.kind === 'unavailable') { publish({ ...state, status: 'unavailable', issue: effective.code }); return; }
                    const manifest = effective.value.effectiveManifest ?? { version: 1 as const };
                    if (state.manifest && sameStrictJsonValue(state.manifest, manifest)) publish({ ...state, status: 'ready' });
                    else {
                        const selection = allSelection(manifest);
                        publish({ ...initial, status: 'ready', manifest, selection, preview: preview(manifest, selection) });
                    }
                } catch (error) { publish({ ...state, status: 'unavailable', issue: readActionErrorCodeV1(error) ?? 'action_failed' }); }
                finally { loading = null; }
            })();
            return loading;
        },
        select,
        acknowledgeWarning(value: boolean) { if (state.preview && !state.pending) publish({ ...state, warningAcknowledged: value }); },
        /** Returns inspectable .happier/project.json bytes to the existing answering-client save/copy surface. */
        export(): Readonly<{ kind: 'ready'; bytes: string }> | Extract<ProjectSetupShareResult, { kind: 'warningRequired' | 'unavailable' }> {
            if (!active || state.status !== 'ready' || !state.preview) return { kind: 'unavailable', code: state.issue ?? 'project_setup_review_unavailable' };
            return state.warningAcknowledged ? { kind: 'ready', bytes: state.preview.bytes } : { kind: 'warningRequired' };
        },
        publish(target: ProjectSetupShareTarget): Promise<ProjectSetupShareResult> {
            if (publishing) return publishing;
            if (!active || state.status !== 'ready' || !state.preview) return Promise.resolve({ kind: 'unavailable', code: state.issue ?? 'project_setup_review_unavailable' });
            if (!state.warningAcknowledged) return Promise.resolve({ kind: 'warningRequired' });
            const reviewed = state.preview;
            publish({ ...state, pending: true, issue: null });
            publishing = (async (): Promise<ProjectSetupShareResult> => {
                let publication = state.publication;
                try {
                    publication ??= await input.client.createSharedSetup(reviewed.manifest, target.title);
                    publish({ ...state, publication });
                    const attached = await input.client.attachSharedSetup({ ...target, publication });
                    if (!attached.ok) {
                        publish({ ...state, issue: attached.error });
                        return { kind: 'savedNotAttached', publication, code: attached.error, refusal: attached };
                    }
                    return { kind: 'attached', publication, source: attached.source };
                } catch (error) {
                    const code = readActionErrorCodeV1(error) ?? 'action_failed';
                    publish({ ...state, issue: code });
                    return publication ? { kind: 'savedNotAttached', publication, code } : { kind: 'unavailable', code };
                } finally { publish({ ...state, pending: false }); publishing = null; }
            })();
            return publishing;
        },
    };
}
