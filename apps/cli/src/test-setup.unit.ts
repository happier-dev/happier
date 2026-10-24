import { setup } from './test-setup'
import { sweepOrphanedTestProcessTempDirs } from './testkit/fs/testProcessTempDirs'

export default async function globalSetup() {
  sweepOrphanedTestProcessTempDirs()
  await setup({ buildMode: 'shared-only' })
  // Forked workers are usually terminated without exit hooks; their pids are gone by teardown.
  return () => sweepOrphanedTestProcessTempDirs()
}
