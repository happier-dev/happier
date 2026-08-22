import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { collectFileInventory } from './collectFileInventory.ts';
import {
  type DeclarationRewriteAction,
  type DeclarationRewriteRow,
} from './migrationTypes.ts';
import {
  applyRewritePlan,
  type DeclarationRewritePlan,
  type RewritePlanApplyResult,
  planDeclarationRewrites,
} from './rewriteImports.ts';

export const PLUGIN_SDK_PACKAGE_NAME = '@happier-dev/plugin-sdk';
export const PLUGIN_SDK_MIGRATION_MAP_PATH =
  '.project/plans/plugin-sdk-author-surface-convergence/symbol-map/MIGRATION-MAP.generated.json';
export const PLUGIN_SDK_MIGRATION_SEARCH_ROOTS = ['apps', 'packages', 'scripts'] as const;
export const PLUGIN_SDK_MIGRATION_SOURCE_PATTERN = /\.[cm]?[jt]sx?$/;

export type PluginSdkMigrationMapAction = DeclarationRewriteAction | 'add';

export interface PluginSdkMigrationMapRow {
  action: PluginSdkMigrationMapAction;
  canonicalSourceOwner: string;
  sourceSpecifier: string;
  sourceSymbol: string;
  targetSpecifier: string;
  targetSymbol: string;
  removalCondition: string;
  deltaRecheck?: string;
}

export type PluginSdkMigrationMapRefusalReason =
  | 'pending-target'
  | 'plugin-owned-target'
  | 'non-package-source'
  | 'non-package-target'
  | 'invalid-safe-row';

export interface PluginSdkMigrationMapRefusal {
  filePath: '(migration-map)';
  rowIndex: number;
  sourceSpecifier: string;
  symbol: string;
  reason: PluginSdkMigrationMapRefusalReason;
  owner: string;
  detail: string;
}

export interface AdaptedPluginSdkMigrationMap {
  rewriteRows: readonly DeclarationRewriteRow[];
  additions: readonly PluginSdkMigrationMapRow[];
  nonInputs: readonly PluginSdkMigrationMapRow[];
  mapRefusals: readonly PluginSdkMigrationMapRefusal[];
  actionCounts: Readonly<Record<PluginSdkMigrationMapAction, number>>;
}

export interface PlanPluginSdkMigrationOptions {
  rootDir?: string;
  mapPath?: string;
  mapRows?: readonly PluginSdkMigrationMapRow[];
}

export interface PluginSdkMigrationPlanResult {
  rootDir: string;
  mapPath: string;
  filesScanned: number;
  candidateFilesScanned: number;
  searchRoots: readonly string[];
  adaptedMap: AdaptedPluginSdkMigrationMap;
  plan: DeclarationRewritePlan;
}

export interface RunPluginSdkMigrationOptions extends PlanPluginSdkMigrationOptions {
  write?: boolean;
}

export interface PluginSdkMigrationRunResult extends PluginSdkMigrationPlanResult {
  mode: 'dry-run' | 'write';
  applyResult: RewritePlanApplyResult | null;
  secondDryRun: DeclarationRewritePlan | null;
  idempotent: boolean | null;
  ok: boolean;
}

const MAP_ACTIONS = new Set<PluginSdkMigrationMapAction>([
  'add',
  'delete',
  'internalize',
  'manual_semantic_migration',
  'move',
  'rename',
  'retain',
]);

function compareMapRows(left: PluginSdkMigrationMapRow, right: PluginSdkMigrationMapRow): number {
  return left.sourceSpecifier.localeCompare(right.sourceSpecifier)
    || left.sourceSymbol.localeCompare(right.sourceSymbol)
    || left.action.localeCompare(right.action)
    || left.targetSpecifier.localeCompare(right.targetSpecifier)
    || left.targetSymbol.localeCompare(right.targetSymbol);
}

function compareMapRefusals(
  left: PluginSdkMigrationMapRefusal,
  right: PluginSdkMigrationMapRefusal,
): number {
  return left.sourceSpecifier.localeCompare(right.sourceSpecifier)
    || left.symbol.localeCompare(right.symbol)
    || left.reason.localeCompare(right.reason)
    || left.rowIndex - right.rowIndex;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(
  row: Record<string, unknown>,
  key: keyof PluginSdkMigrationMapRow,
  rowIndex: number,
): string {
  const value = row[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Plugin SDK migration map row ${rowIndex} has invalid ${key}`);
  }
  return value;
}

function parseMapRow(value: unknown, rowIndex: number): PluginSdkMigrationMapRow {
  if (!isRecord(value)) {
    throw new Error(`Plugin SDK migration map row ${rowIndex} must be an object`);
  }
  const action = requiredString(value, 'action', rowIndex);
  if (!MAP_ACTIONS.has(action as PluginSdkMigrationMapAction)) {
    throw new Error(`Plugin SDK migration map row ${rowIndex} has unsupported action ${action}`);
  }
  const deltaRecheck = value.deltaRecheck;
  if (deltaRecheck !== undefined && typeof deltaRecheck !== 'string') {
    throw new Error(`Plugin SDK migration map row ${rowIndex} has invalid deltaRecheck`);
  }
  return {
    action: action as PluginSdkMigrationMapAction,
    canonicalSourceOwner: requiredString(value, 'canonicalSourceOwner', rowIndex),
    sourceSpecifier: requiredString(value, 'sourceSpecifier', rowIndex),
    sourceSymbol: requiredString(value, 'sourceSymbol', rowIndex),
    targetSpecifier: requiredString(value, 'targetSpecifier', rowIndex),
    targetSymbol: requiredString(value, 'targetSymbol', rowIndex),
    removalCondition: requiredString(value, 'removalCondition', rowIndex),
    ...(deltaRecheck === undefined ? {} : { deltaRecheck }),
  };
}

export function loadPluginSdkMigrationMap(mapPath: string): PluginSdkMigrationMapRow[] {
  const parsed: unknown = JSON.parse(readFileSync(mapPath, 'utf8'));
  if (!Array.isArray(parsed)) {
    throw new Error('Plugin SDK migration map must be a JSON array');
  }
  return parsed.map(parseMapRow);
}

function isCanonicalSubpath(value: string): boolean {
  const segments = value.split('/');
  return segments.length > 0 && segments.every((segment) => (
    segment !== '.'
    && segment !== '..'
    && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment)
  ));
}

function sourcePackageSpecifier(sourceSpecifier: string): string | null {
  if (sourceSpecifier === '.') return PLUGIN_SDK_PACKAGE_NAME;
  if (sourceSpecifier.startsWith('./') && isCanonicalSubpath(sourceSpecifier.slice(2))) {
    return `${PLUGIN_SDK_PACKAGE_NAME}/${sourceSpecifier.slice(2)}`;
  }
  return null;
}

function targetPackageSpecifier(targetSpecifier: string): string | null {
  if (targetSpecifier === '.') return PLUGIN_SDK_PACKAGE_NAME;
  if (targetSpecifier.startsWith('/') && isCanonicalSubpath(targetSpecifier.slice(1))) {
    return `${PLUGIN_SDK_PACKAGE_NAME}${targetSpecifier}`;
  }
  return null;
}

function markerReason(value: string, position: 'source' | 'target'): PluginSdkMigrationMapRefusalReason {
  if (position === 'target' && value === 'PENDING') return 'pending-target';
  if (position === 'target' && value === 'PLUGIN-OWNED') return 'plugin-owned-target';
  return position === 'source' ? 'non-package-source' : 'non-package-target';
}

function mapRefusal(
  row: PluginSdkMigrationMapRow,
  rowIndex: number,
  reason: PluginSdkMigrationMapRefusalReason,
  detail: string,
): PluginSdkMigrationMapRefusal {
  return {
    filePath: '(migration-map)',
    rowIndex,
    sourceSpecifier: row.sourceSpecifier,
    symbol: row.sourceSymbol,
    reason,
    owner: row.canonicalSourceOwner,
    detail,
  };
}

function manualRowForUnresolvedTarget(
  row: PluginSdkMigrationMapRow,
  sourceSpecifier: string,
  detail: string,
): DeclarationRewriteRow {
  return {
    sourceSpecifier,
    sourceSymbol: row.sourceSymbol,
    targetSpecifier: null,
    targetSymbol: null,
    action: 'manual_semantic_migration',
    owner: row.canonicalSourceOwner,
    reason: detail,
  };
}

function declarationRowKey(sourceSpecifier: string, sourceSymbol: string): string {
  return `${sourceSpecifier}#${sourceSymbol}`;
}

function withSafeTargetIdentities(
  primaryRows: readonly DeclarationRewriteRow[],
  additionalTargetIdentities: readonly DeclarationRewriteRow[] = [],
): DeclarationRewriteRow[] {
  const rowsByIdentity = new Map<string, DeclarationRewriteRow>();
  for (const row of primaryRows) {
    const key = declarationRowKey(row.sourceSpecifier, row.sourceSymbol);
    if (rowsByIdentity.has(key)) {
      throw new Error(`Duplicate Plugin SDK migration input: ${key}`);
    }
    rowsByIdentity.set(key, row);
  }

  const addTargetIdentity = (identity: DeclarationRewriteRow): void => {
    const key = declarationRowKey(identity.sourceSpecifier, identity.sourceSymbol);
    const existing = rowsByIdentity.get(key);
    if (existing) {
      const isSameTargetIdentity = existing.action === 'retain'
        && existing.sourceSpecifier === identity.sourceSpecifier
        && existing.sourceSymbol === identity.sourceSymbol
        && existing.targetSpecifier === identity.targetSpecifier
        && existing.targetSymbol === identity.targetSymbol;
      if (isSameTargetIdentity) return;
      throw new Error(`Conflicting Plugin SDK migration target: ${key}`);
    }

    rowsByIdentity.set(key, identity);
  };

  for (const row of primaryRows) {
    if (
      (row.action !== 'move' && row.action !== 'rename' && row.action !== 'retain')
      || !row.targetSpecifier
      || !row.targetSymbol
    ) {
      continue;
    }

    addTargetIdentity({
      sourceSpecifier: row.targetSpecifier,
      sourceSymbol: row.targetSymbol,
      targetSpecifier: row.targetSpecifier,
      targetSymbol: row.targetSymbol,
      action: 'retain',
      owner: row.owner,
      reason: row.reason,
    });
  }
  for (const identity of additionalTargetIdentities) {
    addTargetIdentity(identity);
  }

  return [...rowsByIdentity.values()];
}

export function adaptPluginSdkMigrationMap(
  mapRows: readonly PluginSdkMigrationMapRow[],
): AdaptedPluginSdkMigrationMap {
  const rewriteRows: DeclarationRewriteRow[] = [];
  const addedTargetIdentities: DeclarationRewriteRow[] = [];
  const additions: PluginSdkMigrationMapRow[] = [];
  const nonInputs: PluginSdkMigrationMapRow[] = [];
  const mapRefusals: PluginSdkMigrationMapRefusal[] = [];
  const actionCounts: Record<PluginSdkMigrationMapAction, number> = {
    add: 0,
    delete: 0,
    internalize: 0,
    manual_semantic_migration: 0,
    move: 0,
    rename: 0,
    retain: 0,
  };

  mapRows.forEach((row, rowIndex) => {
    actionCounts[row.action] += 1;
    if (row.action === 'add') {
      const targetSpecifier = targetPackageSpecifier(row.targetSpecifier);
      if (!targetSpecifier || row.targetSymbol === '-') {
        const reason = !targetSpecifier
          ? markerReason(row.targetSpecifier, 'target')
          : 'invalid-safe-row';
        mapRefusals.push(mapRefusal(
          row,
          rowIndex,
          reason,
          `${row.action} requires an exact target package specifier and symbol; ${row.removalCondition}`,
        ));
      } else {
        additions.push(row);
        addedTargetIdentities.push({
          sourceSpecifier: targetSpecifier,
          sourceSymbol: row.targetSymbol,
          targetSpecifier,
          targetSymbol: row.targetSymbol,
          action: 'retain',
          owner: row.canonicalSourceOwner,
          reason: row.removalCondition,
        });
      }
      return;
    }

    if (row.sourceSpecifier === '-' || row.sourceSpecifier === 'UNBARRELLED_SOURCE') {
      nonInputs.push(row);
      return;
    }

    const sourceSpecifier = sourcePackageSpecifier(row.sourceSpecifier);
    if (!sourceSpecifier) {
      mapRefusals.push(mapRefusal(
        row,
        rowIndex,
        markerReason(row.sourceSpecifier, 'source'),
        `${row.sourceSpecifier} is not an exact Plugin SDK package specifier; ${row.removalCondition}`,
      ));
      return;
    }

    if (row.targetSpecifier === 'PLUGIN-OWNED') {
      const detail = `PLUGIN-OWNED requires semantic migration to its owning plugin; ${row.removalCondition}`;
      rewriteRows.push(manualRowForUnresolvedTarget(row, sourceSpecifier, detail));
      return;
    }

    if (row.action === 'internalize' || row.action === 'delete') {
      rewriteRows.push({
        sourceSpecifier,
        sourceSymbol: row.sourceSymbol,
        targetSpecifier: null,
        targetSymbol: null,
        action: row.action,
        owner: row.canonicalSourceOwner,
        reason: row.removalCondition,
      });
      return;
    }

    if (row.action === 'manual_semantic_migration') {
      const targetSpecifier = targetPackageSpecifier(row.targetSpecifier);
      if (!targetSpecifier) {
        const reason = markerReason(row.targetSpecifier, 'target');
        const detail = `${row.targetSpecifier} is not an exact Plugin SDK target; ${row.removalCondition}`;
        mapRefusals.push(mapRefusal(row, rowIndex, reason, detail));
        rewriteRows.push(manualRowForUnresolvedTarget(row, sourceSpecifier, detail));
        return;
      }
      if (sourceSpecifier === targetSpecifier && row.sourceSymbol === row.targetSymbol) {
        rewriteRows.push({
          sourceSpecifier,
          sourceSymbol: row.sourceSymbol,
          targetSpecifier,
          targetSymbol: row.targetSymbol,
          action: 'retain',
          owner: row.canonicalSourceOwner,
          reason: row.removalCondition,
        });
        return;
      }
      rewriteRows.push({
        sourceSpecifier,
        sourceSymbol: row.sourceSymbol,
        targetSpecifier: null,
        targetSymbol: null,
        action: row.action,
        owner: row.canonicalSourceOwner,
        reason: row.removalCondition,
      });
      return;
    }

    const targetSpecifier = targetPackageSpecifier(row.targetSpecifier);
    if (!targetSpecifier || row.targetSymbol === '-') {
      const reason = !targetSpecifier
        ? markerReason(row.targetSpecifier, 'target')
        : 'invalid-safe-row';
      const detail = `${row.action} requires an exact target package specifier and symbol; ${row.removalCondition}`;
      mapRefusals.push(mapRefusal(row, rowIndex, reason, detail));
      rewriteRows.push(manualRowForUnresolvedTarget(row, sourceSpecifier, detail));
      return;
    }

    rewriteRows.push({
      sourceSpecifier,
      sourceSymbol: row.sourceSymbol,
      targetSpecifier,
      targetSymbol: row.targetSymbol,
      action: row.action,
      owner: row.canonicalSourceOwner,
      reason: row.removalCondition,
    });
  });

  const rewriteRowsWithTargetIdentities = withSafeTargetIdentities(
    rewriteRows,
    addedTargetIdentities,
  );

  return {
    rewriteRows: rewriteRowsWithTargetIdentities.sort((left, right) => (
      left.sourceSpecifier.localeCompare(right.sourceSpecifier)
      || left.sourceSymbol.localeCompare(right.sourceSymbol)
      || left.action.localeCompare(right.action)
    )),
    additions: additions.sort(compareMapRows),
    nonInputs: nonInputs.sort(compareMapRows),
    mapRefusals: mapRefusals.sort(compareMapRefusals),
    actionCounts,
  };
}

function resolveMapPath(rootDir: string, mapPath: string | undefined): string {
  const selected = mapPath ?? PLUGIN_SDK_MIGRATION_MAP_PATH;
  return isAbsolute(selected) ? selected : join(rootDir, selected);
}

export function planPluginSdkMigration(
  options: PlanPluginSdkMigrationOptions = {},
): PluginSdkMigrationPlanResult {
  const rootDir = options.rootDir ?? process.cwd();
  const mapPath = resolveMapPath(rootDir, options.mapPath);
  const mapRows = options.mapRows ?? loadPluginSdkMigrationMap(mapPath);
  const adaptedMap = adaptPluginSdkMigrationMap(mapRows);
  const inventory = collectFileInventory({
    rootDir,
    searchRoots: PLUGIN_SDK_MIGRATION_SEARCH_ROOTS,
    include: PLUGIN_SDK_MIGRATION_SOURCE_PATTERN,
  });
  const candidateInventory = inventory.filter((file) => (
    file.content.includes(PLUGIN_SDK_PACKAGE_NAME)
  ));
  return {
    rootDir,
    mapPath,
    filesScanned: inventory.length,
    candidateFilesScanned: candidateInventory.length,
    searchRoots: PLUGIN_SDK_MIGRATION_SEARCH_ROOTS,
    adaptedMap,
    plan: planDeclarationRewrites(candidateInventory, adaptedMap.rewriteRows),
  };
}

export function applyPluginSdkMigrationPlan(
  rootDir: string,
  plan: DeclarationRewritePlan,
): RewritePlanApplyResult {
  return applyRewritePlan(rootDir, plan);
}

export function runPluginSdkMigration(
  options: RunPluginSdkMigrationOptions = {},
): PluginSdkMigrationRunResult {
  const planned = planPluginSdkMigration(options);
  if (options.write !== true) {
    return {
      ...planned,
      mode: 'dry-run',
      applyResult: null,
      secondDryRun: null,
      idempotent: null,
      ok: planned.plan.refusals.length === 0 && planned.adaptedMap.mapRefusals.length === 0,
    };
  }

  if (planned.plan.refusals.length > 0 || planned.adaptedMap.mapRefusals.length > 0) {
    return {
      ...planned,
      mode: 'write',
      applyResult: { appliedEdits: [], skippedEdits: [] },
      secondDryRun: null,
      idempotent: false,
      ok: false,
    };
  }

  const applyResult = applyPluginSdkMigrationPlan(planned.rootDir, planned.plan);
  const second = planPluginSdkMigration(options);
  const idempotent = applyResult.skippedEdits.length === 0
    && second.plan.edits.length === 0
    && second.plan.refusals.length === 0;
  return {
    ...planned,
    mode: 'write',
    applyResult,
    secondDryRun: second.plan,
    idempotent,
    ok: idempotent
      && planned.plan.refusals.length === 0
      && planned.adaptedMap.mapRefusals.length === 0,
  };
}
