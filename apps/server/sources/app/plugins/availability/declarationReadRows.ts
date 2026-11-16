import type { Tx } from '@/storage/inTx';
import { getActivePrismaRuntime, getDbProviderFromEnv } from '@/storage/prisma';
import { portableQueryChunks } from '@/storage/portableQueryChunks';

/**
 * MySQL form of the same storage projection (binary JSON column). A machine's
 * position is kept by aggregating in JSON_TABLE ordinality order.
 */
function mysqlReleaseLessDeclarationIdentitySql() {
    const prisma = getActivePrismaRuntime();
    const doc = "(CASE WHEN JSON_TYPE(i.`releaseLessDeclaration`) = 'OBJECT' THEN i.`releaseLessDeclaration` ELSE JSON_OBJECT() END)";
    // JSON_OBJECT keeps null members, like PostgreSQL's jsonb_build_object.
    const identityMembers = (value: string, path: string) => `
        'manifestDigestSha256', JSON_EXTRACT(${value}, '${path}.manifestDigestSha256'),
        'manifest', JSON_OBJECT(
            'schemaVersion', JSON_EXTRACT(${value}, '${path}.manifest.schemaVersion'),
            'id', JSON_EXTRACT(${value}, '${path}.manifest.id'),
            'version', JSON_EXTRACT(${value}, '${path}.manifest.version'),
            'contributes', CASE WHEN JSON_TYPE(JSON_EXTRACT(${value}, '${path}.manifest.contributes')) = 'OBJECT'
                THEN JSON_OBJECT() ELSE NULL END)`;
    const identity = (value: string, path: string) => `JSON_OBJECT(${identityMembers(value, path)})`;
    return prisma.sql`JSON_OBJECT(${prisma.raw(identityMembers(doc, '$'))},
        'schemaVersion', CASE WHEN JSON_EXTRACT(${prisma.raw(doc)}, '$.schemaVersion') = CAST(3 AS JSON)
            THEN CAST(2 AS JSON) ELSE JSON_EXTRACT(${prisma.raw(doc)}, '$.schemaVersion') END,
        'legacyDeclaration', ${prisma.raw(identity(doc, '$.legacyDeclaration'))},
        'machines', CASE WHEN JSON_TYPE(JSON_EXTRACT(${prisma.raw(doc)}, '$.machines')) = 'ARRAY'
            THEN COALESCE((SELECT JSON_ARRAYAGG(JSON_OBJECT(
                    'machineId', JSON_EXTRACT(e.value, '$.machineId'),
                    'machineInstallationId', JSON_EXTRACT(e.value, '$.machineInstallationId'),
                    'declaration', ${prisma.raw(identity('e.value', '$.declaration'))}))
                    OVER (ORDER BY e.ordinal ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING)
                FROM JSON_TABLE(JSON_EXTRACT(${prisma.raw(doc)}, '$.machines'), '$[*]'
                    COLUMNS (ordinal FOR ORDINALITY, value JSON PATH '$')) e LIMIT 1), JSON_ARRAY())
            ELSE NULL END)`;
}

/**
 * SQLite form of the same storage projection (JSON text column, read once as
 * JSONB). Machine entries are addressed through the root document so that any
 * element type projects like PostgreSQL's `->` (non-objects yield null fields).
 */
function sqliteReleaseLessDeclarationIdentitySql() {
    const prisma = getActivePrismaRuntime();
    // json_object keeps null members, like PostgreSQL's jsonb_build_object.
    const identityMembers = (path: string) => `
        'manifestDigestSha256', d.v -> (${path} || '.manifestDigestSha256'),
        'manifest', json_object(
            'schemaVersion', d.v -> (${path} || '.manifest.schemaVersion'),
            'id', d.v -> (${path} || '.manifest.id'),
            'version', d.v -> (${path} || '.manifest.version'),
            'contributes', CASE WHEN json_type(d.v, ${path} || '.manifest.contributes') = 'object'
                THEN json('{}') ELSE NULL END)`;
    return prisma.sql`(
        SELECT json_object(${prisma.raw(identityMembers("'$'"))},
            'schemaVersion', CASE WHEN CAST(d.v -> '$.schemaVersion' AS TEXT) = '3' THEN 2 ELSE d.v -> '$.schemaVersion' END,
            'legacyDeclaration', json_object(${prisma.raw(identityMembers("'$.legacyDeclaration'"))}),
            'machines', CASE WHEN json_type(d.v, '$.machines') = 'array'
                THEN (SELECT json_group_array(json_object(
                    'machineId', d.v -> ('$.machines[' || e.key || '].machineId'),
                    'machineInstallationId', d.v -> ('$.machines[' || e.key || '].machineInstallationId'),
                    'declaration', json_object(${prisma.raw(identityMembers("('$.machines[' || e.key || '].declaration')"))})))
                    FROM (SELECT key FROM json_each(d.v, '$.machines') ORDER BY key) e)
                ELSE NULL END)
        FROM (SELECT CASE WHEN json_valid(i."releaseLessDeclaration") AND json_type(i."releaseLessDeclaration") = 'object'
            THEN jsonb(i."releaseLessDeclaration") ELSE jsonb('{}') END AS v) d
    )`;
}

/** Storage-only identity projection. Currentness remains owned by currentDeclaration. */
export function releaseLessDeclarationIdentitySql() {
    const prisma = getActivePrismaRuntime();
    const provider = getDbProviderFromEnv(process.env, 'postgres');
    if (provider === 'sqlite') return sqliteReleaseLessDeclarationIdentitySql();
    if (provider === 'mysql') return mysqlReleaseLessDeclarationIdentitySql();
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
            'schemaVersion', CASE WHEN d."schemaVersion" = '3'::jsonb THEN '2'::jsonb ELSE d."schemaVersion" END,
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
    const mysql = getDbProviderFromEnv(process.env, 'postgres') === 'mysql';
    const identifier = (name: string) => prisma.raw(mysql ? `\`${name}\`` : `"${name}"`);
    for (const ids of portableQueryChunks({ values: pluginIds, bindingsPerValue: 1, fixedBindings: 2 })) {
        const projected = await tx.$queryRaw<Array<Readonly<{ pluginId: string; enabled: boolean | number;
            desiredVersion: string | null; releaseLessDeclaration: unknown }>>>(prisma.sql`
                SELECT i.${identifier('pluginId')} AS ${identifier('pluginId')}, i.enabled AS enabled,
                    i.${identifier('desiredVersion')} AS ${identifier('desiredVersion')},
                    CASE WHEN i.${identifier('desiredVersion')} IS NULL THEN ${releaseLessDeclarationIdentitySql()}
                        ELSE NULL END AS ${identifier('releaseLessDeclaration')}
                FROM ${identifier('AccountPluginIntent')} i
                WHERE i.${identifier('accountId')} = ${accountId} AND i.${identifier('pluginId')} IN (${prisma.join([...ids])})
            `);
        // SQLite returns the projection as JSON text and booleans as integers.
        rows.push(...projected.map(row => ({ pluginId: row.pluginId, enabled: row.enabled === true || row.enabled === 1,
            desiredVersion: row.desiredVersion, releaseLessDeclaration: typeof row.releaseLessDeclaration === 'string'
                ? JSON.parse(row.releaseLessDeclaration) as unknown : row.releaseLessDeclaration })));
    }
    return rows;
}

/**
 * Read only the manifests selected by the domain owner, in the caller's snapshot.
 * `member` projects one path inside each selected manifest (absent members read as null).
 */
export async function readSelectedDeclarationManifestsTx(tx: Tx, accountId: string,
    selected: readonly Readonly<{ key: string; pluginId: string; path: readonly string[]; declarationDigestSha256: string }>[],
    member: readonly string[] = []) {
    if (selected.length === 0) return new Map<string, unknown>();
    const prisma = getActivePrismaRuntime();
    const provider = getDbProviderFromEnv(process.env, 'postgres');
    // SQLite and MySQL share the JSON path syntax.
    const jsonPath = (segments: readonly string[]) => `$${segments.map((segment) => {
        if (/^\d+$/.test(segment)) return `[${segment}]`;
        if (segment.includes('"')) throw new Error('Unsupported declaration path segment');
        return `."${segment}"`;
    }).join('')}`;
    const pathRequests = () => JSON.stringify(selected.map((entry, index) => ({ key: String(index), pluginId: entry.pluginId,
        digest: entry.declarationDigestSha256, bodyPath: jsonPath([...entry.path, ...member]),
        manifestsPath: jsonPath(['manifests', entry.declarationDigestSha256, ...member]),
        digestPath: jsonPath([...entry.path.slice(0, -1), 'manifestDigestSha256']) })));
    if (provider === 'mysql') {
        const rows = await tx.$queryRaw<Readonly<{ key: string; manifest: string | null }>[]>(prisma.sql`
            SELECT r.requestKey AS \`key\`, CAST(CASE WHEN JSON_EXTRACT(i.\`releaseLessDeclaration\`, '$.schemaVersion') = CAST(3 AS JSON)
                    THEN JSON_EXTRACT(i.\`releaseLessDeclaration\`, r.manifestsPath)
                    ELSE JSON_EXTRACT(i.\`releaseLessDeclaration\`, r.bodyPath) END AS CHAR) AS manifest
            FROM JSON_TABLE(CAST(${pathRequests()} AS JSON), '$[*]' COLUMNS (
                requestKey VARCHAR(16) PATH '$.key', pluginId VARCHAR(255) PATH '$.pluginId', digest VARCHAR(255) PATH '$.digest',
                bodyPath TEXT PATH '$.bodyPath', manifestsPath TEXT PATH '$.manifestsPath', digestPath TEXT PATH '$.digestPath')) r
            JOIN \`AccountPluginIntent\` i ON i.\`accountId\` = ${accountId} AND i.\`pluginId\` = r.pluginId
            -- ReadCommitted callers can observe a replacement between the identity and body reads.
            -- Never pair a replacement body with the previously selected declaration digest.
            WHERE JSON_UNQUOTE(JSON_EXTRACT(i.\`releaseLessDeclaration\`, r.digestPath)) = r.digest
        `);
        return new Map(rows.map(row => [selected[Number(row.key)]!.key,
            row.manifest === null ? null : JSON.parse(row.manifest) as unknown]));
    }
    if (provider === 'sqlite') {
        const requests = pathRequests();
        const rows = await tx.$queryRaw<Readonly<{ key: string; manifest: string | null }>[]>(prisma.sql`
            SELECT q.request ->> '$.key' AS key,
                CASE WHEN CAST(q.v -> '$.schemaVersion' AS TEXT) = '3' THEN q.v -> (q.request ->> '$.manifestsPath')
                    ELSE q.v -> (q.request ->> '$.bodyPath') END AS manifest
            FROM (SELECT r.value AS request, CASE WHEN json_valid(i."releaseLessDeclaration")
                    THEN jsonb(i."releaseLessDeclaration") ELSE jsonb('null') END AS v
                FROM json_each(${requests}) r
                JOIN "AccountPluginIntent" i ON i."accountId" = ${accountId} AND i."pluginId" = r.value ->> '$.pluginId') q
            -- ReadCommitted callers can observe a replacement between the identity and body reads.
            -- Never pair a replacement body with the previously selected declaration digest.
            WHERE q.v ->> (q.request ->> '$.digestPath') = q.request ->> '$.digest'
        `);
        return new Map(rows.map(row => [selected[Number(row.key)]!.key,
            row.manifest === null ? null : JSON.parse(row.manifest) as unknown]));
    }
    const rows = await tx.$queryRaw<Readonly<{ key: string; manifest: unknown }>[]>(prisma.sql`
        SELECT r.key, (${selectedDeclarationBodySql(
            'i."releaseLessDeclaration" #> ARRAY(SELECT jsonb_array_elements_text(r.path))',
            'r."declarationDigestSha256"')}) #> ARRAY(SELECT jsonb_array_elements_text(CAST(${JSON.stringify(member)} AS jsonb))) AS manifest
        FROM jsonb_to_recordset(CAST(${JSON.stringify(selected.map((entry, index) => ({ ...entry, key: String(index), digestPath: [...entry.path.slice(0, -1), "manifestDigestSha256"] })))} AS jsonb)) AS r(key text, "pluginId" text, path jsonb, "digestPath" jsonb, "declarationDigestSha256" text)
        JOIN "AccountPluginIntent" i ON i."accountId" = ${accountId} AND i."pluginId" = r."pluginId"
        -- ReadCommitted callers can observe a replacement between the identity and body reads.
        -- Never pair a replacement body with the previously selected declaration digest.
        WHERE i."releaseLessDeclaration" #>> ARRAY(SELECT jsonb_array_elements_text(r."digestPath")) = r."declarationDigestSha256"
    `);
    return new Map(rows.map(row => [selected[Number(row.key)]!.key, row.manifest]));
}

/** Both selected-body readers share the same physical-format translation. */
export function selectedDeclarationBodySql(inlineExpression: string, digestExpression: string) {
    const prisma = getActivePrismaRuntime();
    return prisma.sql`CASE WHEN i."releaseLessDeclaration"->>'schemaVersion' = '3'
        THEN i."releaseLessDeclaration"->'manifests'->(${prisma.raw(digestExpression)})
        ELSE ${prisma.raw(inlineExpression)} END`;
}
