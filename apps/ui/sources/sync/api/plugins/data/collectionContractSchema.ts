import {
    PluginCollectionContractAccessReadResultV1Schema,
    PluginCollectionContractReadResultV1Schema,
    type NormalizedPluginAccountCollectionContractV1,
    type PluginCollectionContractReadResultV1,
} from '@happier-dev/protocol/plugins/data/collectionsV1';
import type { PluginCollectionContractRefV1 } from '@happier-dev/protocol/plugins/data/collectionContractRefV1';
import { createPluginJsonSchemaZodValueAdapter, preparePluginJsonSchema, type PluginJsonSchemaValidator } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';

export type PreparedCollectionContractSchema = Readonly<{
    validate: PluginJsonSchemaValidator;
    storedReadSchema: ReturnType<typeof createPluginJsonSchemaZodValueAdapter>;
}>;

type AdmittedContract = {
    /** Exact wire text of the admitted contract; an equal answer reuses its parse. */
    readonly wire: string;
    readonly contract: NormalizedPluginAccountCollectionContractV1;
    readonly schemaText: string;
    prepared?: PreparedCollectionContractSchema;
};

/**
 * Sole UI owner of an admitted Collection contract's parsed shape and compiled
 * schema. Both are pure functions of the contract content, so an entry is
 * reused only when the content is equal: an equal wire answer returns the
 * admitted contract, and an equal schema returns its compiled validator and
 * stored-read adapter. A changed schema under the same digest is re-prepared,
 * so the server's digest is never trusted in place of content.
 *
 * One entry per contract digest, replaced on changed content. The set of
 * digests is the installed releases' Collection contracts, so it stays small;
 * entries hold no Account data or authority (access is parsed per answer).
 */
const admittedContracts = new Map<string, AdmittedContract>();

function readWireDigest(body: unknown): string | null {
    if (body === null || typeof body !== 'object') return null;
    const contract = (body as { contract?: unknown }).contract;
    if (contract === null || typeof contract !== 'object') return null;
    const digest = (contract as { contractDigest?: unknown }).contractDigest;
    return typeof digest === 'string' ? digest : null;
}

/**
 * The contract a server answer already delivered for this exact ref, if any.
 * A contract is immutable per digest, so its holder asks the server for
 * access only (`omitContract`) instead of re-reading and re-comparing it.
 * Entries prepared from a local contract were never answered and do not count.
 */
export function readHeldCollectionContract(
    ref: PluginCollectionContractRefV1,
): NormalizedPluginAccountCollectionContractV1 | null {
    const entry = admittedContracts.get(ref.contractDigest);
    if (!entry || entry.wire === '') return null;
    const { contract } = entry;
    return contract.pluginId === ref.pluginId && contract.collectionId === ref.collectionId
        && contract.schemaVersion === ref.schemaVersion ? contract : null;
}

/**
 * Parses one contract read answer; an answer equal to an admitted one reuses
 * its contract. An access-only answer is valid only for a read that declared
 * `held` (the contract returned by `readHeldCollectionContract`).
 */
export function parseCollectionContractReadResult(
    body: unknown,
    held?: NormalizedPluginAccountCollectionContractV1 | null,
): PluginCollectionContractReadResultV1 | null {
    if (held) {
        const answer = PluginCollectionContractAccessReadResultV1Schema.safeParse(body);
        if (answer.success) return { access: answer.data.access, contract: held };
    }
    const digest = readWireDigest(body);
    const wire = digest === null ? null : JSON.stringify((body as { contract: unknown }).contract);
    const existing = digest === null ? undefined : admittedContracts.get(digest);
    if (existing && existing.wire === wire) {
        const access = (body as { access?: unknown }).access;
        if (access !== 'readOnly' && access !== 'writable') return null;
        if (Object.keys(body as object).length !== 2) return null;
        return { access, contract: existing.contract };
    }
    const parsed = PluginCollectionContractReadResultV1Schema.safeParse(body);
    if (!parsed.success) return null;
    if (wire !== null) {
        const schemaText = JSON.stringify(parsed.data.contract.schema);
        const retained = admittedContracts.get(parsed.data.contract.contractDigest);
        admittedContracts.set(parsed.data.contract.contractDigest, {
            wire,
            contract: parsed.data.contract,
            schemaText,
            // An equal schema keeps its compiled pair.
            ...(retained?.prepared && retained.schemaText === schemaText ? { prepared: retained.prepared } : {}),
        });
    }
    return parsed.data;
}

/** The compiled validator and stored-read adapter for one admitted contract's schema. */
export function prepareCollectionContractSchema(
    contract: NormalizedPluginAccountCollectionContractV1,
): PreparedCollectionContractSchema {
    let entry = admittedContracts.get(contract.contractDigest);
    if (!entry || (entry.contract !== contract && entry.schemaText !== JSON.stringify(contract.schema))) {
        entry = { wire: '', contract, schemaText: JSON.stringify(contract.schema) };
        admittedContracts.set(contract.contractDigest, entry);
    }
    if (!entry.prepared) {
        // Admit the answered schema once; the stored reader reuses the
        // normalizer's own snapshot instead of admitting the wire copy again.
        const { jsonSchema, validate } = preparePluginJsonSchema(entry.contract.schema);
        entry.prepared = Object.freeze({
            validate,
            storedReadSchema: createStoredReadSchema(createPluginJsonSchemaZodValueAdapter(jsonSchema)),
        });
    }
    return entry.prepared;
}
