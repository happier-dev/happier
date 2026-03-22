export type EnforcementMode = 'enforce' | 'report-only';

export interface InventoryFile {
  filePath: string;
  content: string;
}

export interface DeprecatedImportRule {
  id: string;
  mode: EnforcementMode;
  scope: 'tests-only' | 'all-source';
  from: string;
  replacement?: string;
  rationale: string;
}

export interface PatternRule {
  id: string;
  mode: EnforcementMode;
  scope: 'tests-only' | 'all-source';
  kind: 'substring' | 'regex';
  pattern: string | RegExp;
  rationale: string;
  suggestedReplacement?: string;
}

export interface InventoryBucketSummary {
  ruleId: string;
  count: number;
  files: string[];
}

export interface DuplicatePatternInventoryReport {
  buckets: readonly InventoryBucketSummary[];
  filesScanned: number;
  totalMatches: number;
}

export interface DeprecatedImportInventoryReport {
  buckets: readonly InventoryBucketSummary[];
  filesScanned: number;
  totalMatches: number;
}

export interface RewriteRule {
  id: string;
  from: string;
  to: string;
  namedImportMap?: Readonly<Record<string, string>>;
}

export interface RewriteEdit {
  filePath: string;
  before: string;
  after: string;
}

export interface RewritePlan {
  edits: readonly RewriteEdit[];
}
