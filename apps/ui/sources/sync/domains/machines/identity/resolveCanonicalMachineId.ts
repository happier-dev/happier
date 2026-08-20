/**
 * The machine replacement chain walk moved to `@happier-dev/protocol` so the daemon
 * decides "does this machine host the Session?" with the SAME resolution the client
 * uses to choose its RPC target. Two walks would let the client address a successor
 * machine the daemon then refuses as foreign.
 *
 * Re-exported here so every existing import keeps its owner-local path.
 */
export {
    resolveCanonicalMachineId,
    type MachineReplacementRecord,
} from '@happier-dev/protocol';
