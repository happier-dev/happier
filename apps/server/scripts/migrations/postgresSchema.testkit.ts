// Read only PostgreSQL-owned schema metadata. The ledger is compared separately;
// runtime-created tables are deliberately not hidden by this catalog reader.
export const POSTGRES_SEMANTIC_SCHEMA_QUERY = `
WITH owned_tables AS (
    SELECT c.oid,c.relname,c.relkind,c.relpersistence
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=current_schema() AND c.relkind IN ('r','p')
      AND c.relname <> '_prisma_migrations'
), columns AS (
    SELECT t.relname AS table_name,a.attname AS column_name,
           format_type(a.atttypid,a.atttypmod) AS data_type,
           pg_get_expr(d.adbin,d.adrelid) AS column_default,
           NOT a.attnotnull AS is_nullable,a.attidentity AS identity_kind,
           a.attgenerated AS generated_kind,cn.nspname AS collation_schema,
           co.collname AS collation_name
    FROM owned_tables t JOIN pg_attribute a ON a.attrelid=t.oid
    LEFT JOIN pg_attrdef d ON d.adrelid=t.oid AND d.adnum=a.attnum
    LEFT JOIN pg_collation co ON co.oid=a.attcollation
    LEFT JOIN pg_namespace cn ON cn.oid=co.collnamespace
    WHERE a.attnum > 0 AND NOT a.attisdropped
), constraints AS (
    SELECT t.relname AS table_name,k.conname,k.contype,
           pg_get_constraintdef(k.oid) AS definition,
           k.condeferrable,k.condeferred,k.convalidated,
           CASE WHEN rn.nspname=current_schema() THEN NULL ELSE rn.nspname END AS referenced_schema,
           r.relname AS referenced_table
    FROM owned_tables t JOIN pg_constraint k ON k.conrelid=t.oid
    LEFT JOIN pg_class r ON r.oid=k.confrelid
    LEFT JOIN pg_namespace rn ON rn.oid=r.relnamespace
), indexes AS (
    SELECT t.relname AS table_name,i.relname AS index_name,
           replace(pg_get_indexdef(i.oid),' ON '||quote_ident(current_schema())||'.',' ON ') AS definition,
           x.indisvalid,x.indisready
    FROM owned_tables t JOIN pg_index x ON x.indrelid=t.oid
    JOIN pg_class i ON i.oid=x.indexrelid
), triggers AS (
    SELECT t.relname AS table_name,g.tgname AS trigger_name,g.tgenabled AS enabled,
           replace(replace(pg_get_triggerdef(g.oid,true),
               ' ON '||quote_ident(current_schema())||'.',' ON '),
               ' EXECUTE FUNCTION '||quote_ident(current_schema())||'.',' EXECUTE FUNCTION ') AS definition,
           replace(pg_get_functiondef(g.tgfoid),
               'CREATE OR REPLACE FUNCTION '||quote_ident(current_schema())||'.',
               'CREATE OR REPLACE FUNCTION ') AS function_definition
    FROM owned_tables t JOIN pg_trigger g ON g.tgrelid=t.oid
    WHERE NOT g.tgisinternal
)
SELECT jsonb_build_object(
    'tables',COALESCE((SELECT jsonb_agg(jsonb_build_object('table_name',relname,'kind',relkind,'persistence',relpersistence) ORDER BY relname) FROM owned_tables),'[]'::jsonb),
    'columns',COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY table_name,column_name) FROM columns c),'[]'::jsonb),
    'constraints',COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY table_name,conname) FROM constraints c),'[]'::jsonb),
    'indexes',COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY table_name,index_name) FROM indexes i),'[]'::jsonb),
    'triggers',COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY table_name,trigger_name) FROM triggers t),'[]'::jsonb)
) AS snapshot
`;

export async function readPostgresSemanticSchema(db: Readonly<{
    query: (sql: string) => Promise<Record<string, unknown>[]>;
}>): Promise<unknown> {
    const [row] = await db.query(POSTGRES_SEMANTIC_SCHEMA_QUERY);
    if (!row?.snapshot) throw new Error('PostgreSQL semantic schema snapshot unavailable');
    return row.snapshot;
}
