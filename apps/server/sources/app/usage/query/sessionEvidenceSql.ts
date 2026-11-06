import { resolveDbSqlDialect } from '@/config/databaseProvider';
import { getDbProviderFromEnv } from '@/storage/prisma';

/** Static JSON expressions for the Usage storage projection, on the shipped SQL engines. */
export function sessionEvidenceSql() {
    const dialect = resolveDbSqlDialect(getDbProviderFromEnv(process.env, 'postgres'));
    const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'";
    const column = (name: string) => dialect === 'mysql' ? '`' + name + '`' : '"' + name + '"';
    const path = (parts: readonly string[]) => literal('$' + parts.map(part => '."' + part.replaceAll('"', '\\"') + '"').join(''));
    const json = (value: string, ...parts: string[]) => !parts.length ? value : dialect === 'postgres'
        ? `(${value} #> ${literal('{' + parts.join(',') + '}')})` : dialect === 'sqlite'
            ? `(${value} -> ${path(parts)})` : `JSON_EXTRACT(${value}, ${path(parts)})`;
    const remove = (value: string, ...parts: string[]) => dialect === 'postgres'
        ? `(${value} #- ${literal('{' + parts.join(',') + '}')})` : `JSON_REMOVE(${value}, ${path(parts)})`;
    const text = (value: string, ...parts: string[]) => dialect === 'postgres'
        ? `(${value} #>> ${literal('{' + parts.join(',') + '}')})` : dialect === 'mysql'
            ? `NULLIF(JSON_UNQUOTE(${json(value, ...parts)}), 'null')` : `JSON_EXTRACT(${value}, ${path(parts)})`;
    const type = (value: string) => dialect === 'postgres' ? `jsonb_typeof(${value})` : dialect === 'sqlite'
        ? `(CASE JSON_TYPE(${value}) WHEN 'text' THEN 'string' ELSE JSON_TYPE(${value}) END)` : `LOWER(JSON_TYPE(${value}))`;
    const emptyObject = dialect === 'postgres' ? "'{}'::jsonb" : "JSON_OBJECT()";
    const emptyArray = dialect === 'postgres' ? "'[]'::jsonb" : "JSON_ARRAY()";
    const safeObject = (value: string) => `CASE WHEN ${type(value)} = 'object' THEN ${value} ELSE ${emptyObject} END`;
    const safeArray = (value: string) => `CASE WHEN ${type(value)} = 'array' THEN ${value} ELSE ${emptyArray} END`;
    const isObjectText = (value: string) => dialect === 'postgres' ? `${value} IS JSON OBJECT`
        : `(CASE WHEN JSON_VALID(${value}) THEN ${type(value)} = 'object' ELSE FALSE END)`;
    const parseText = (value: string) => dialect === 'postgres'
        ? `CASE WHEN ${value} IS JSON OBJECT THEN ${value}::jsonb ELSE ${emptyObject} END`
        : `CASE WHEN JSON_VALID(${value}) THEN ${safeObject(value)} ELSE ${emptyObject} END`;
    const parseObject = (value: string) => `CASE WHEN ${type(value)} = 'object' THEN ${value}
        WHEN ${type(value)} = 'string' AND SUBSTR(TRIM(${text(value)}),1,1)='{' THEN ${parseText(text(value))} ELSE ${emptyObject} END`;
    const object = (entries: Readonly<Record<string, string>>) => {
        const values = Object.entries(entries).flatMap(([key, value]) => [literal(key), value]).join(', ');
        return `${dialect === 'postgres' ? 'jsonb_build_object' : 'JSON_OBJECT'}(${values})`;
    };
    const embed = (value: string) => dialect === 'sqlite' ? `JSON(${value})` : value;
    const sparseObject = (entries: Readonly<Record<string, string>>) => {
        const rows = Object.entries(entries).map(([key, value]) => `SELECT ${literal(key)} AS k, ${value} AS v`).join(' UNION ALL ');
        const aggregate = dialect === 'postgres' ? 'jsonb_object_agg(k,v)' : dialect === 'sqlite'
            ? 'json_group_object(k,JSON(v))' : 'JSON_OBJECTAGG(k,v)';
        return `(SELECT COALESCE(${aggregate},${emptyObject}) FROM (${rows}) fields WHERE v IS NOT NULL)`;
    };
    const members = (value: string, kind: 'object' | 'array', alias: string) => {
        const safe = kind === 'object' ? safeObject(value) : safeArray(value);
        return dialect === 'postgres' ? `${kind === 'object' ? 'jsonb_each' : 'jsonb_array_elements'}(${safe}) AS ${alias}`
            : dialect === 'sqlite' ? `json_each(${safe}) AS ${alias}`
                : `JSON_TABLE(${safe}, '${kind === 'object' ? '$.*' : '$[*]'}' COLUMNS(value JSON PATH '$')) AS ${alias}`;
    };
    const collect = (value: string) => dialect === 'postgres' ? `COALESCE(jsonb_agg(${value}), ${emptyArray})`
        : dialect === 'sqlite' ? `COALESCE(json_group_array(JSON(${value})), ${emptyArray})`
            : `COALESCE(JSON_ARRAYAGG(${value}), ${emptyArray})`;
    const objectEntries = (value: string, alias: string) => {
        const safe = safeObject(value);
        if (dialect !== 'mysql') return { from: members(value, 'object', alias), key: `${alias}.key`, value: `${alias}.value` };
        const key = `JSON_EXTRACT(JSON_KEYS(${safe}),CONCAT('$[',${alias}.ordinality-1,']'))`;
        return { from: `JSON_TABLE(JSON_KEYS(${safe}), '$[*]' COLUMNS(ordinality FOR ORDINALITY)) AS ${alias}`,
            key: `JSON_UNQUOTE(${key})`, value: `JSON_EXTRACT(${safe},CONCAT('$.',${key}))` };
    };
    const collectObject = (key: string, value: string) => `COALESCE(${dialect === 'postgres' ? `jsonb_object_agg(${key},${value})`
        : dialect === 'sqlite' ? `json_group_object(${key},JSON(${value}))` : `JSON_OBJECTAGG(${key},${value})`},${emptyObject})`;
    const nativeJson = (value: string) => dialect === 'postgres' ? `${value}::jsonb` : value;
    const machineId = (metadata: string, ownerEnvelope: string, layout: string) => `CASE WHEN ${layout}=1
        THEN ${text(ownerEnvelope, 'v', 'workspace', 'machineId')} ELSE ${text(metadata, 'machineId')} END`;
    return { dialect, literal, column, json, remove, text, type, object, sparseObject, embed, members, collect, parseText, parseObject,
        safeArray, safeObject, emptyArray, emptyObject, nativeJson, isObjectText, objectEntries, collectObject, machineId };
}
