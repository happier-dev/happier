import type { Tx } from '@/storage/inTx';
import { getActivePrismaRuntime, getDbProviderFromEnv } from '@/storage/prisma';
import { portableQueryChunks } from '@/storage/portableQueryChunks';

/** Storage-only identity projection. Currentness remains owned by currentDeclaration. */
export function releaseLessDeclarationIdentitySql() {
    const prisma = getActivePrismaRuntime();
    // This is a storage projection, not a declaration decision: preserve every
    // identity field and whether contributes is an object. The domain owner
    // applies the same envelope validation and consensus selection to it.
    const declarationIdentity = (digestExpression: string, manifestExpression: string) => {
        const digest = prisma.raw(digestExpression);
        const manifest = prisma.raw(manifestExpression);
        return prisma.sql`jsonb_build_object(
            'manifestDigestSha256', ${digest},
            'manifest', jsonb_build_object(
                'schemaVersion', ${manifest}->'schemaVersion',
                'id', ${manifest}->'id',
                'version', ${manifest}->'version',
                'contributes', CASE WHEN jsonb_typeof(${manifest}->'contributes') = 'object'
                    THEN '{}'::jsonb ELSE NULL END))`;
    };
    return prisma.sql`(
        SELECT ${declarationIdentity('d."manifestDigestSha256"', 'd.manifest')} || jsonb_build_object(
            'schemaVersion', d."schemaVersion",
            'legacyDeclaration', ${declarationIdentity('(d."legacyDeclaration"->\'manifestDigestSha256\')', '(d."legacyDeclaration"->\'manifest\')')},
            'machines', CASE WHEN jsonb_typeof(d.machines) = 'array'
                THEN (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                    'machineId', e.value->'machineId',
                    'machineInstallationId', e.value->'machineInstallationId',
                    'declaration', ${declarationIdentity('(e.value->\'declaration\'->\'manifestDigestSha256\')', '(e.value->\'declaration\'->\'manifest\')')}) ORDER BY e.ordinality), '[]'::jsonb)
                    FROM jsonb_array_elements(d.machines) WITH ORDINALITY e(value, ordinality))
                ELSE NULL END)
        FROM jsonb_to_record(CASE WHEN jsonb_typeof(i."releaseLessDeclaration") = 'object'
            THEN i."releaseLessDeclaration" ELSE '{}'::jsonb END)
            AS d("schemaVersion" jsonb, machines jsonb, "legacyDeclaration" jsonb, "manifestDigestSha256" jsonb, manifest jsonb)
    )`;
}

type DeclarationIntentIdentity = Readonly<{
    pluginId: string;
    enabled: boolean;
    desiredVersion: string | null;
    releaseLessDeclaration: unknown;
}>;

/** Fetch declaration identities without transferring any Machine manifest bodies. */
export async function readDeclarationIntentIdentitiesTx(tx: Tx, accountId: string, pluginIds: readonly string[]) {
    const rows: DeclarationIntentIdentity[] = [];
    const prisma = getActivePrismaRuntime();
    for (const ids of portableQueryChunks({ values: pluginIds, bindingsPerValue: 1, fixedBindings: 2 })) {
        rows.push(...getDbProviderFromEnv(process.env, 'postgres') !== 'postgres'
            ? await tx.accountPluginIntent.findMany({ where: { accountId, pluginId: { in: [...ids] } },
                select: { pluginId: true, enabled: true, desiredVersion: true, releaseLessDeclaration: true } })
            : await tx.$queryRaw<DeclarationIntentIdentity[]>(prisma.sql`
                SELECT i."pluginId", i.enabled, i."desiredVersion",
                    CASE WHEN i."desiredVersion" IS NULL THEN ${releaseLessDeclarationIdentitySql()}
                        ELSE NULL END AS "releaseLessDeclaration"
                FROM "AccountPluginIntent" i WHERE i."accountId" = ${accountId} AND i."pluginId" IN (${prisma.join([...ids])})
            `));
    }
    return rows;
}

/** Read only the manifests selected by the domain owner, in the caller's snapshot. */
export async function readSelectedDeclarationManifestsTx(tx: Tx, accountId: string,
    selected: readonly Readonly<{ key: string; pluginId: string; path: readonly string[]; declarationDigestSha256: string }>[]) {
    if (selected.length === 0) return new Map<string, unknown>();
    const prisma = getActivePrismaRuntime();
    const rows = await tx.$queryRaw<Readonly<{ key: string; manifest: unknown }>[]>(prisma.sql`
        SELECT r.key, i."releaseLessDeclaration" #> ARRAY(SELECT jsonb_array_elements_text(r.path)) AS manifest
        FROM jsonb_to_recordset(CAST(${JSON.stringify(selected.map((entry, index) => ({ ...entry, key: String(index), digestPath: [...entry.path.slice(0, -1), "manifestDigestSha256"] })))} AS jsonb)) AS r(key text, "pluginId" text, path jsonb, "digestPath" jsonb, "declarationDigestSha256" text)
        JOIN "AccountPluginIntent" i ON i."accountId" = ${accountId} AND i."pluginId" = r."pluginId"
        -- ReadCommitted callers can observe a replacement between the identity and body reads.
        -- Never pair a replacement body with the previously selected declaration digest.
        WHERE i."releaseLessDeclaration" #>> ARRAY(SELECT jsonb_array_elements_text(r."digestPath")) = r."declarationDigestSha256"
    `);
    return new Map(rows.map(row => [selected[Number(row.key)]!.key, row.manifest]));
}
