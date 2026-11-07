import { readWidgetSurfaceArtifactHeaderV1, WIDGET_SURFACE_ARTIFACT_KIND_V1 } from '@happier-dev/protocol/widgets';
import type { DecryptedArtifact } from '../../domains/artifacts/artifactTypes';
import { widgetAreaLayoutSurfaceKey } from '../../domains/widgets/widgetAreaLayoutSurface';

type Publication = Readonly<{ surfaceKey: string; headerVersion: number; bodyVersion: number | undefined }>;
/** Admitted revision facts only; unchanged surfaces keep their subscription identity. */
export type WidgetAreaLayoutPublications = Readonly<{
    byArtifactId: ReadonlyMap<string, Publication>;
    bySurface: ReadonlyMap<string, ReadonlyMap<string, Publication>>;
}>;

export function projectWidgetAreaLayoutPublications(
    index: WidgetAreaLayoutPublications,
    before: Readonly<Record<string, DecryptedArtifact>>,
    after: Readonly<Record<string, DecryptedArtifact>>,
    changedIds: Iterable<string>,
): WidgetAreaLayoutPublications {
    let byArtifactId = index.byArtifactId;
    let bySurface = index.bySurface;
    for (const id of changedIds) {
        const previous = byArtifactId.get(id);
        const artifact = after[id];
        let current: Publication | undefined;
        if (artifact?.isDecrypted && artifact.access === 'owner'
            && artifact.rawHeader?.kind === WIDGET_SURFACE_ARTIFACT_KIND_V1) {
            // Retained admitted headers need no second schema/identity admission on body arrivals.
            const header = previous && before[id]?.rawHeader === artifact.rawHeader ? null
                : readWidgetSurfaceArtifactHeaderV1({ artifactId: id, header: artifact.rawHeader });
            const surfaceKey = previous && before[id]?.rawHeader === artifact.rawHeader
                && before[id]?.ownerAccountId === artifact.ownerAccountId ? previous.surfaceKey
                : header && header.surface.accountId === artifact.ownerAccountId ? widgetAreaLayoutSurfaceKey(header.surface) : undefined;
            if (surfaceKey) current = { surfaceKey, headerVersion: artifact.headerVersion, bodyVersion: artifact.bodyVersion };
        }
        if (previous?.surfaceKey === current?.surfaceKey && previous?.headerVersion === current?.headerVersion
            && previous?.bodyVersion === current?.bodyVersion) continue;
        if (byArtifactId === index.byArtifactId) byArtifactId = new Map(byArtifactId);
        if (current) (byArtifactId as Map<string, Publication>).set(id, current);
        else (byArtifactId as Map<string, Publication>).delete(id);
        for (const surfaceKey of new Set([previous?.surfaceKey, current?.surfaceKey])) {
            if (!surfaceKey) continue;
            if (bySurface === index.bySurface) bySurface = new Map(bySurface);
            const retained = bySurface.get(surfaceKey);
            const bucket = !retained || retained === index.bySurface.get(surfaceKey)
                ? new Map(retained) : retained as Map<string, Publication>;
            if (current?.surfaceKey === surfaceKey) bucket.set(id, current);
            else bucket.delete(id);
            if (bucket.size) (bySurface as Map<string, ReadonlyMap<string, Publication>>).set(surfaceKey, bucket);
            else (bySurface as Map<string, ReadonlyMap<string, Publication>>).delete(surfaceKey);
        }
    }
    return byArtifactId === index.byArtifactId ? index : { byArtifactId, bySurface };
}
