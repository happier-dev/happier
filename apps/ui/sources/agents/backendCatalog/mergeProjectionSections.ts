import type { MachineContributionRegistryProjectionDescribeResult } from '@/sync/ops/machineContributionRegistryProjection';

type ReadyProjection = Extract<MachineContributionRegistryProjectionDescribeResult, { supported: true }>;

/** Independent demands publish into one held answer, qualified by its admitted manifest. */
export function mergeProjectionSections(incoming: ReadyProjection, previous: ReadyProjection): ReadyProjection {
    const next = incoming.deferredProjection;
    const before = previous.deferredProjection;
    if (!next || next.manifest.projectionDigest !== (before?.manifest.projectionDigest ?? previous.projectionDigest)) return incoming;
    // A full answer already covers every section of this same manifest.
    if (!before) return previous;
    if (before.loadedSections.every(section => next.loadedSections.includes(section))) return incoming;

    const loaded = new Set(next.loadedSections);
    const field = <K extends keyof ReadyProjection['projection']>(name: K): ReadyProjection['projection'][K] =>
        loaded.has(name) ? incoming.projection[name] : previous.projection[name];
    // An unchanged response refers to the issuer's held inputs. A concurrent
    // section publication has expanded that answer, so publish the joined facts.
    const { unchanged: _unchanged, ...response } = incoming;
    return {
        ...previous,
        ...response,
        projection: {
            ...previous.projection,
            ...incoming.projection,
            installedPackagesById: field('installedPackagesById'),
            agentsById: field('agentsById'),
            actionsById: field('actionsById'),
            resourcesById: field('resourcesById'),
            settingsById: field('settingsById'),
            familiesById: { ...previous.projection.familiesById, ...incoming.projection.familiesById },
        },
        deferredProjection: {
            manifest: next.manifest,
            loadedSections: [...new Set([...before.loadedSections, ...next.loadedSections])],
        },
        sectionBodies: new Map([...(previous.sectionBodies ?? []), ...(incoming.sectionBodies ?? [])]),
    };
}
