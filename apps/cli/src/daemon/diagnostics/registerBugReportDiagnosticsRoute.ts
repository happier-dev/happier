import type { FastifyInstance } from 'fastify';
import { BugReportDiagnosticsRequestSchema } from '@happier-dev/protocol/bugs/reports/machineDiagnostics';
import { collectBugReportMachineDiagnosticsSnapshotForBugReport } from '@/diagnostics/bugReportMachineDiagnosticsRecipe';
import { createDaemonControlRequestLifetime } from '../controlRequestLifetime';
import { createDaemonControlAuthGuard } from '../controlAuth';

/** Local OS-owner transport; remote Machine callers retain their requester admission. */
export function registerBugReportDiagnosticsRoute(app: FastifyInstance, input: Readonly<{
  controlToken: string;
  machineId: string;
}>): void {
  app.post('/diagnostics/bug-report/collect', {
    preHandler: createDaemonControlAuthGuard(input.controlToken),
  }, async (request, reply) => {
    const parsed = BugReportDiagnosticsRequestSchema.safeParse(request.body);
    if (!parsed.success) return await reply.code(400).send({ error: 'invalid_diagnostics_request' });
    const lifetime = createDaemonControlRequestLifetime(request, reply);
    try {
      return await lifetime.run(() => collectBugReportMachineDiagnosticsSnapshotForBugReport(parsed.data, {
        machineId: input.machineId, signal: lifetime.signal,
        assertCurrentAuthority: async () => lifetime.signal.throwIfAborted(),
      }));
    } finally { lifetime.dispose(); }
  });
}
