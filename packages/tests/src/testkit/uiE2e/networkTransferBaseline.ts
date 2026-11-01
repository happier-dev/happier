import { comparableNetworkReports, usableNetworkReport, type NetworkTransferReport } from './networkTransferReport';

export type NetworkBaselineRun = { id: number; head_branch: string; head_sha: string; event: string; conclusion: string; head_repository: { full_name: string } };
export type NetworkBaselineReader = {
  runs(page: number): Promise<NetworkBaselineRun[]>;
  reports(run: NetworkBaselineRun): Promise<NetworkTransferReport[]>;
};

/** Only successful push CI from the named repository/base branch can supply data.
 * Never pick a lower-byte retry or skip a failed attempt in a candidate cohort.
 * Pagination ends at the API's available history; there is no local search budget.
 */
export async function findNetworkTransferBaseline(input: {
  current: NetworkTransferReport; repository: string; branch: string; currentRun?: string;
  reader: NetworkBaselineReader; warn(message: string): void;
}) {
  for (let page = 1; ; page += 1) {
    const runs = await input.reader.runs(page);
    if (runs.length === 0) return undefined;
    for (const run of runs) {
      if (String(run.id) === input.currentRun || run.event !== 'push' || run.conclusion !== 'success'
        || run.head_branch !== input.branch || run.head_repository.full_name !== input.repository) continue;
      let reports: NetworkTransferReport[];
      try { reports = await input.reader.reports(run); }
      catch { input.warn(`Base run ${run.id}: artifact invalid or unavailable; continuing successful base history.`); continue; }
      if (reports.length === 0) continue;
      if (reports.some((r) => !usableNetworkReport(r) || r.retry !== 0 || r.ci.branch !== input.branch
        || r.ci.run !== String(run.id) || r.ci.sha !== run.head_sha)) {
        input.warn(`Base run ${run.id}: failed, retried or mismatched workload; not a baseline.`);
        continue;
      }
      // Hosted job has one repetition. Multiple successful repetitions are displayed
      // individually on current runs, rather than reduced to a favorable observation.
      if (reports.length === 1 && comparableNetworkReports(input.current, reports[0])) return { run, report: reports[0] };
      input.warn(`Base run ${run.id}: workload/schema/runtime not comparable.`);
    }
  }
}
