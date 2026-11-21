import { composeServerConfigRegistry, type ServerConfigRegistry } from './serverConfigEntry.js';
import { EMAIL_SERVER_CONFIG } from './entries/emailEntries.js';
import { INTEGRATIONS_SERVER_CONFIG } from './entries/integrationsEntries.js';
import { POLICIES_SERVER_CONFIG } from './entries/policiesEntries.js';
import { REACH_SERVER_CONFIG } from './entries/reachEntries.js';
import { SERVER_RUNTIME_SERVER_CONFIG } from './entries/serverRuntimeEntries.js';
import { STORAGE_SERVER_CONFIG } from './entries/storageEntries.js';

/**
 * The hand-written part of the server configuration registry (plan §3.14): every key the server
 * reads that has no structured owner of its own. Feature keys, API rate limits and retention
 * domains are declared by their owners in `apps/server` and joined with these entries by
 * `registerServerConfigFamilies`; the coverage check fails when server source reads a key that
 * neither part declares.
 */
export const SERVER_CONFIG = {
    ...EMAIL_SERVER_CONFIG,
    ...INTEGRATIONS_SERVER_CONFIG,
    ...POLICIES_SERVER_CONFIG,
    ...REACH_SERVER_CONFIG,
    ...SERVER_RUNTIME_SERVER_CONFIG,
    ...STORAGE_SERVER_CONFIG,
} as const;

/** The same entries as one validated registry (duplicate keys or aliases across groups throw). */
export const SERVER_CONFIG_REGISTRY_BASE: ServerConfigRegistry = composeServerConfigRegistry(
    EMAIL_SERVER_CONFIG,
    INTEGRATIONS_SERVER_CONFIG,
    POLICIES_SERVER_CONFIG,
    REACH_SERVER_CONFIG,
    SERVER_RUNTIME_SERVER_CONFIG,
    STORAGE_SERVER_CONFIG,
);
