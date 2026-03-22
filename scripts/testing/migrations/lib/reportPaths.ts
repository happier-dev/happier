export const GOVERNANCE_REPORT_DIRECTORY = '.project/testing/reports/governance';

export const GOVERNANCE_REPORT_PATHS = Object.freeze({
  inventorySummaryMarkdown: `${GOVERNANCE_REPORT_DIRECTORY}/inventory-summary.md`,
  inventorySummaryJson: `${GOVERNANCE_REPORT_DIRECTORY}/inventory-summary.json`,
  deprecatedImportsMarkdown: `${GOVERNANCE_REPORT_DIRECTORY}/deprecated-imports.md`,
  deprecatedImportsJson: `${GOVERNANCE_REPORT_DIRECTORY}/deprecated-imports.json`,
  duplicatePatternsMarkdown: `${GOVERNANCE_REPORT_DIRECTORY}/duplicate-patterns.md`,
  duplicatePatternsJson: `${GOVERNANCE_REPORT_DIRECTORY}/duplicate-patterns.json`,
  rolloutStateMarkdown: `${GOVERNANCE_REPORT_DIRECTORY}/rollout-state.md`,
  commandsRunMarkdown: `${GOVERNANCE_REPORT_DIRECTORY}/commands-run.md`,
  migrationAccountingMarkdown: `${GOVERNANCE_REPORT_DIRECTORY}/migration-accounting.md`,
});
