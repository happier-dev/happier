import { appendHeartbeatDiagnostic } from './heartbeatDiagnostic.mjs';

export default class VitestHeartbeatReporter {
  async onTestModuleStart(testModule) {
    const diagnosticPath = process.env.HAPPIER_CI_DIAGNOSTIC_PATH;
    if (!diagnosticPath) return;
    await appendHeartbeatDiagnostic(diagnosticPath, {
      event: 'module-start',
      moduleId: testModule.moduleId,
    });
  }
}
