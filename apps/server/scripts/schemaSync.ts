import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdir } from 'node:fs/promises';

export function normalizeSchemaText(input: string): string {
    return input.replace(/\r\n/g, '\n').trimEnd() + '\n';
}

function normalizeGeneratedTs(input: string): string {
    return input.replace(/\r\n/g, '\n').trimEnd() + '\n';
}

type EnumDef = { name: string; values: string[] };

function parseEnums(schemaText: string): EnumDef[] {
    const text = schemaText.replace(/\r\n/g, '\n');
    const out: EnumDef[] = [];
    const enumRe = /^\s*enum\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{([\s\S]*?)^\s*\}\s*$/gm;
    let m: RegExpExecArray | null;
    while ((m = enumRe.exec(text))) {
        const name = m[1]!;
        const body = m[2] ?? '';
        const values = body
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l && !l.startsWith('//'))
            // Each enum member is an identifier, optionally with attributes like @map(...)
            .map((l) => l.split(/\s+/)[0])
            .filter(Boolean);
        out.push({ name, values });
    }
    return out;
}

export function generateEnumsTsFromPostgres(postgresSchema: string): string {
    const enums = parseEnums(postgresSchema);
    if (enums.length === 0) {
        throw new Error('Failed to find any enum blocks in prisma/schema.prisma');
    }

    const header = [
        '// AUTO-GENERATED FILE - DO NOT EDIT.',
        '// Source: prisma/schema.prisma',
        '// Regenerate: yarn schema:sync',
        '',
    ].join('\n');

    const chunks: string[] = [header];
    for (const e of enums) {
        chunks.push(`export const ${e.name} = {`);
        for (const v of e.values) {
            const key = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(v) ? v : JSON.stringify(v);
            chunks.push(`    ${key}: "${v}",`);
        }
        chunks.push('} as const;');
        chunks.push('');
        chunks.push(`export type ${e.name} = (typeof ${e.name})[keyof typeof ${e.name}];`);
        chunks.push('');
    }

    return normalizeGeneratedTs(chunks.join('\n'));
}

export function generateSqliteSchemaFromPostgres(postgresSchema: string): string {
    return generateProviderSchemaFromPostgres(postgresSchema, {
        provider: "sqlite",
        output: "../../generated/sqlite-client",
        previewFeatures: ["metrics"],
    });
}

export function generateMySqlSchemaFromPostgres(postgresSchema: string): string {
    return generateProviderSchemaFromPostgres(postgresSchema, {
        provider: "mysql",
        output: "../../generated/mysql-client",
        previewFeatures: ["metrics", "relationJoins"],
    });
}

function generateProviderSchemaFromPostgres(
    postgresSchema: string,
    opts: { provider: "sqlite" | "mysql"; output: string; previewFeatures: string[] },
): string {
    const schema = postgresSchema.replace(/\r\n/g, '\n');

    const datasource = /(^|\n)\s*datasource\s+db\s*{[\s\S]*?\n}\s*\n/m;
    const match = schema.match(datasource);
    if (!match || match.index == null) {
        throw new Error('Failed to find `datasource db { ... }` block in prisma/schema.prisma');
    }

    const bodyStart = match.index + match[0].length;
    const rawBody = schema.slice(bodyStart);

    let body = normalizeSchemaText(rawBody)
        .replace(/^\s+/, '')
        .replace(/(\w+)\(\s*sort\s*:\s*\w+\s*\)/g, '$1');

    if (opts.provider === "sqlite") {
        body = stripRelationMapArguments(body);
    }

    if (opts.provider === "mysql") {
        // MySQL cannot create UNIQUE/INDEX keys on BLOB/TEXT columns without a key length.
        // `PublicSessionShare.tokenHash` stores a sha256 digest (32 bytes) and must be indexed.
        body = body.replace(/^(\s*tokenHash\s+Bytes\s+)@unique\b/gm, "$1@db.VarBinary(32) @unique");

        // `recordId` already owns the canonical account-scoped provider-usage identity. The
        // expanded semantic key is redundant and exceeds InnoDB's utf8mb4 key-size limit.
        body = body.replace(/^\s*@@unique\(\[accountId, providerId, accountSubjectId, quotaScope, quotaScopeIdKey\], map: "paur_scope_key"\)\s*$/m, "");

        body = annotateMySqlQualifiedConnectedAccountFields(body);

	        // MySQL defaults `String` to VARCHAR(191), which is too small for our encrypted state blobs.
	        body = body.replace(/^(\s*metadata\s+String\b)(?![^\n]*@db\.)/gm, "$1 @db.LongText");
	        body = body.replace(/^(\s*ownerMetadata\s+String\?)(?![^\n]*@db\.)/gm, "$1 @db.LongText");
	        body = body.replace(/^(\s*agentState\s+String\?)(?![^\n]*@db\.)/gm, "$1 @db.LongText");
	        body = body.replace(/^(\s*daemonState\s+String\?)(?![^\n]*@db\.)/gm, "$1 @db.LongText");
	        body = body.replace(/^(\s*settings\s+String\?)(?![^\n]*@db\.)/gm, "$1 @db.LongText");
	        body = body.replace(/^(\s*settingsDbValue\s+String\?)(?![^\n]*@db\.)/gm, "$1 @db.LongText");
	        body = body.replace(/^(\s*policyJson\s+String\b)(?![^\n]*@db\.)/gm, "$1 @db.LongText");
	        body = body.replace(/^(\s*stateJson\s+String\?)(?![^\n]*@db\.)/gm, "$1 @db.LongText");

        body = annotateMySqlSessionSubagentCustodyFields(body);

        body = annotateMySqlSessionSystemRecordFields(body);

        body = annotateMySqlPluginPermissionIndexes(body);

        body = annotateMySqlSessionOrganizationFields(body);

        body = annotateMySqlVoiceIdentityFields(body);
	    }

    const header = [
        '// AUTO-GENERATED FILE - DO NOT EDIT.',
        '// Source: prisma/schema.prisma',
        '// Regenerate: yarn schema:sync',
        '',
        '// This is your Prisma schema file,',
        '// learn more about it in the docs: https://pris.ly/d/prisma-schema',
    ].join('\n');

    const generatorClient = [
        'generator client {',
        '    provider        = "prisma-client-js"',
        '    // Include cross-compiled query engines so release artifacts can run on all published server targets.',
        '    binaryTargets   = ["native", "debian-openssl-3.0.x", "linux-arm64-openssl-3.0.x", "darwin", "darwin-arm64", "windows"]',
        `    previewFeatures = [${opts.previewFeatures.map((v) => JSON.stringify(v)).join(", ")}]`,
        `    output          = "${opts.output}"`,
        '}',
    ].join('\n');

    const datasourceDb = [
        'datasource db {',
        `    provider = "${opts.provider}"`,
        '    url      = env("DATABASE_URL")',
        '}',
    ].join('\n');

    return normalizeSchemaText([header, '', generatorClient, '', datasourceDb, '', body].join('\n'));
}

function annotateMySqlSessionSystemRecordFields(schemaBody: string): string {
    return schemaBody.replace(
        /^model\s+SessionSystemRecord\s+\{[\s\S]*?^\}\s*$/gm,
        (model) => model
            .replace(/^(\s*namespace\s+String)(?![^\n]*@db\.)/m, "$1 @db.VarChar(64)")
            .replace(/^(\s*kind\s+String)(?![^\n]*@db\.)/m, "$1 @db.VarChar(64)"),
    );
}

function annotateMySqlPluginPermissionIndexes(schemaBody: string): string {
    const scopeIndex = [
        "accountId",
        "pluginId",
        "capability",
        "scopeKind",
        "scopeProjectId",
        "scopeWorkspaceId",
        "authorityKind",
        "authorityMachineId",
        "authorityInstallationId",
        "status",
    ].map((field) => `${field}(length: 64)`);
    scopeIndex.push("updatedAt");

    const eventIndex = ["accountId", "pluginId", "capability", "eventKind"]
        .map((field) => `${field}(length: 64)`);
    eventIndex.push("createdAt");

    return schemaBody
        .replace(
            /@@index\(\[accountId, pluginId, capability, scopeKind, scopeProjectId, scopeWorkspaceId, authorityKind, authorityMachineId, authorityInstallationId, status, updatedAt\], map: "(plugin_permission_(?:grants|requests)_scope_idx)"\)/g,
            (_match, mapName: string) => `@@index([${scopeIndex.join(", ")}], map: "${mapName}")`,
        )
        .replace(
            /@@index\(\[accountId, pluginId, capability, eventKind, createdAt\], map: "plugin_permission_events_kind_idx"\)/g,
            `@@index([${eventIndex.join(", ")}], map: "plugin_permission_events_kind_idx")`,
        );
}

function annotateMySqlSessionOrganizationFields(schemaBody: string): string {
    return schemaBody
        .replace(
            /^model\s+SessionOrganizationFolder\s+\{[\s\S]*?^\}\s*$/gm,
            (model) => model
                .replace(/^(\s*folderHash\s+String)(?![^\n]*@db\.)/m, "$1 @db.VarChar(71)")
                .replace(/^(\s*parentHash\s+String\?)(?![^\n]*@db\.)/m, "$1 @db.VarChar(71)"),
        )
        .replace(
            /^model\s+SessionOrganizationTag\s+\{[\s\S]*?^\}\s*$/gm,
            (model) => model
                .replace(/^(\s*tagHash\s+String)(?![^\n]*@db\.)/m, "$1 @db.VarChar(71)"),
        )
        .replace(
            /^model\s+SessionOrganizationOrderEntry\s+\{[\s\S]*?^\}\s*$/gm,
            (model) => model
                .replace(/^(\s*scopeKind\s+String)(?![^\n]*@db\.)/m, "$1 @db.VarChar(64)")
                .replace(/^(\s*scopeHash\s+String)(?![^\n]*@db\.)/m, "$1 @db.VarChar(71)")
                .replace(/^(\s*itemKind\s+String)(?![^\n]*@db\.)/m, "$1 @db.VarChar(64)")
                .replace(/^(\s*itemHash\s+String)(?![^\n]*@db\.)/m, "$1 @db.VarChar(71)"),
        )
        .replace(
            /^model\s+SessionOrganizationLabel\s+\{[\s\S]*?^\}\s*$/gm,
            (model) => model
                .replace(/^(\s*scopeHash\s+String)(?![^\n]*@db\.)/m, "$1 @db.VarChar(71)"),
        );
}

function annotateMySqlSessionSubagentCustodyFields(schemaBody: string): string {
    return schemaBody.replace(
        /(^model\s+SessionSubagentCustody\s+\{[\s\S]*?^\}\s*$)|(^model\s+SessionSubagentCustodyReceipt\s+\{[\s\S]*?^\}\s*$)/gm,
        (model) => model
            .replace(/^(\s*subagentId\s+String)(?![^\n]*@db\.)/m, "$1 @db.LongText")
            .replace(/^(\s*groupId\s+String\?)(?![^\n]*@db\.)/m, "$1 @db.LongText")
            .replace(/^(\s*resultSubagentId\s+String)(?![^\n]*@db\.)/m, "$1 @db.LongText")
            .replace(/^(\s*resultGroupId\s+String\?)(?![^\n]*@db\.)/m, "$1 @db.LongText")
            .replace(/^(\s*subagentKey\s+String)(?![^\n]*@db\.)/m, "$1 @db.Char(64)"),
    );
}

function annotateMySqlVoiceIdentityFields(schemaBody: string): string {
    return schemaBody.replace(
        /(^model\s+VoiceSessionLease\s+\{[\s\S]*?^\}\s*$)|(^model\s+VoiceConversation\s+\{[\s\S]*?^\}\s*$)/gm,
        (model) => model
            .replace(/^(\s*sessionId\s+String\?)(?![^\n]*@db\.)/m, "$1 @db.VarChar(512)")
            // The prepare/activate release retains the predecessor raw indexes.
            // VARCHAR(512) would exceed InnoDB's key limit for the lease index.
            .replace(/^(\s*providerConversationId\s+String\??)(?![^\n]*@db\.)/m, "$1 @db.VarChar(191)")
            // Old writers omit this value until the later contract release.
            .replace(
                /^(\s*providerConversationKey\s+String\?)(?![^\n]*@db\.)/m,
                "$1 @db.Char(64)",
            ),
    );
}

function annotateMySqlQualifiedConnectedAccountFields(schemaBody: string): string {
    return schemaBody.replace(
        /(^model\s+ServiceAccountToken\s+\{[\s\S]*?^\}\s*$)|(^model\s+ConnectedServiceUsageSource\s+\{[\s\S]*?^\}\s*$)|(^model\s+ConnectedServiceAuthGroup\s+\{[\s\S]*?^\}\s*$)|(^model\s+ConnectedServiceAuthGroupMember\s+\{[\s\S]*?^\}\s*$)/gm,
        (model) => model
            .replace(/^(\s*servicePluginId\s+String\??)(?![^\n]*@db\.)/m, "$1 @db.LongText")
            .replace(/^(\s*serviceLocalId\s+String\??)(?![^\n]*@db\.)/m, "$1 @db.LongText")
            .replace(/^(\s*connectedAccountId\s+String\??)(?![^\n]*@db\.)/m, "$1 @db.LongText")
            .replace(/^(\s*qualifiedServiceDigest\s+String\??)(?![^\n]*@db\.)/m, "$1 @db.Char(64)")
            .replace(/^(\s*qualifiedIdentityDigest\s+String\??)(?![^\n]*@db\.)/m, "$1 @db.Char(64)")
            .replace(/^(\s*qualifiedGroupDigest\s+String\??)(?![^\n]*@db\.)/m, "$1 @db.Char(64)")
            .replace(/^(\s*activeConnectedAccountId\s+String\?)(?![^\n]*@db\.)/m, "$1 @db.LongText"),
    );
}

function stripRelationMapArguments(schemaBody: string): string {
    return schemaBody.replace(/@relation\(([^)]*)\)/g, (_match, args: string) => {
        const keptArgs = splitTopLevelArgs(args).filter((arg) => !/^\s*map\s*:/.test(arg));
        return `@relation(${keptArgs.map((arg) => arg.trim()).join(", ")})`;
    });
}

function splitTopLevelArgs(args: string): string[] {
    const out: string[] = [];
    let start = 0;
    let bracketDepth = 0;
    let inString = false;
    let escaped = false;

    for (let i = 0; i < args.length; i += 1) {
        const ch = args[i]!;
        if (inString) {
            if (escaped) {
                escaped = false;
                continue;
            }
            if (ch === "\\") {
                escaped = true;
                continue;
            }
            if (ch === '"') {
                inString = false;
            }
            continue;
        }
        if (ch === '"') {
            inString = true;
            escaped = false;
            continue;
        }
        if (ch === "[") {
            bracketDepth += 1;
            continue;
        }
        if (ch === "]") {
            bracketDepth = Math.max(0, bracketDepth - 1);
            continue;
        }
        if (ch === "," && bracketDepth === 0) {
            out.push(args.slice(start, i));
            start = i + 1;
        }
    }

    out.push(args.slice(start));
    return out.filter((arg) => arg.trim().length > 0);
}

function resolveRepoRoot(): string {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    return join(__dirname, '..');
}

async function writeIfChanged(path: string, next: string, normalize: (s: string) => string): Promise<boolean> {
    let existing = '';
    try {
        existing = await readFile(path, 'utf-8');
    } catch {
        // ignore
    }
    if (normalize(existing) === normalize(next)) {
        return false;
    }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, next, 'utf-8');
    return true;
}

async function main(args: string[]): Promise<void> {
    const check = args.includes('--check');
    const quiet = args.includes('--quiet');

    const root = resolveRepoRoot();
    const masterPath = join(root, 'prisma', 'schema.prisma');
    const sqlitePath = join(root, 'prisma', 'sqlite', 'schema.prisma');
    const mysqlPath = join(root, 'prisma', 'mysql', 'schema.prisma');
    const enumsTsPath = join(root, 'sources', 'storage', 'enums.generated.ts');

    const master = await readFile(masterPath, 'utf-8');
    const generatedSqlite = generateSqliteSchemaFromPostgres(master);
    const generatedMysql = generateMySqlSchemaFromPostgres(master);
    const enumsTs = generateEnumsTsFromPostgres(master);

    if (check) {
        let existing = '';
        try {
            existing = await readFile(sqlitePath, 'utf-8');
        } catch {
            // ignore
        }
        if (normalizeSchemaText(existing) !== normalizeSchemaText(generatedSqlite)) {
            console.error('[schema] prisma/sqlite/schema.prisma is out of date.');
            console.error('[schema] Run: yarn schema:sync');
            process.exit(1);
        }

        let existingMysql = '';
        try {
            existingMysql = await readFile(mysqlPath, 'utf-8');
        } catch {
            // ignore
        }
        if (normalizeSchemaText(existingMysql) !== normalizeSchemaText(generatedMysql)) {
            console.error('[schema] prisma/mysql/schema.prisma is out of date.');
            console.error('[schema] Run: yarn schema:sync');
            process.exit(1);
        }

        let existingEnums = '';
        try {
            existingEnums = await readFile(enumsTsPath, 'utf-8');
        } catch {
            // ignore
        }
        if (normalizeGeneratedTs(existingEnums) !== normalizeGeneratedTs(enumsTs)) {
            console.error('[schema] sources/storage/enums.generated.ts is out of date.');
            console.error('[schema] Run: yarn schema:sync');
            process.exit(1);
        }

        if (!quiet) {
            console.log('[schema] prisma/sqlite/schema.prisma is up to date.');
            console.log('[schema] prisma/mysql/schema.prisma is up to date.');
            console.log('[schema] sources/storage/enums.generated.ts is up to date.');
        }
        return;
    }

    if (!quiet) {
        const wroteSqlite = await writeIfChanged(sqlitePath, generatedSqlite, normalizeSchemaText);
        const wroteMysql = await writeIfChanged(mysqlPath, generatedMysql, normalizeSchemaText);
        const wroteEnums = await writeIfChanged(enumsTsPath, enumsTs, normalizeGeneratedTs);
        if (wroteSqlite) console.log('[schema] Wrote prisma/sqlite/schema.prisma');
        if (wroteMysql) console.log('[schema] Wrote prisma/mysql/schema.prisma');
        if (wroteEnums) console.log('[schema] Wrote sources/storage/enums.generated.ts');
        if (!wroteSqlite && !wroteMysql && !wroteEnums) console.log('[schema] No changes.');
    } else {
        await writeIfChanged(sqlitePath, generatedSqlite, normalizeSchemaText);
        await writeIfChanged(mysqlPath, generatedMysql, normalizeSchemaText);
        await writeIfChanged(enumsTsPath, enumsTs, normalizeGeneratedTs);
    }
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isMain) {
    // eslint-disable-next-line no-void
    void main(process.argv.slice(2)).catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
