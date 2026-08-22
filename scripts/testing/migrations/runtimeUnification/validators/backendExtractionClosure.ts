import {
  validateCrossCuttingDuplicateClosure,
  type CrossCuttingDuplicateClosureResult,
  type RuntimeUnificationValidatorFile,
} from './crossCuttingDuplicateClosure.ts';

export const VALIDATOR_ID = 'F.5-backend-extraction-closure';

export function validateBackendExtractionClosure(options?: Readonly<{
  rootDir?: string;
  files?: readonly RuntimeUnificationValidatorFile[];
}>): CrossCuttingDuplicateClosureResult {
  return validateCrossCuttingDuplicateClosure({
    rootDir: options?.rootDir,
    files: options?.files,
    enabledForbiddenFamilies: [
      'F5-permission-lifecycle',
      'F5-jsonl-readline-client',
      'F5-tier2-acp-factory',
      'F5-no-plugin-src-backend',
      'F5-direct-session-vocabulary',
      'F5-mcp-discovery-duplicate',
      'F5-file-follow-duplicate',
      'F5-process-spawn-duplicate',
    ],
  });
}
