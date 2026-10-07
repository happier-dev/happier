import { afterEach, describe, expect, it, vi } from 'vitest';
import { log } from '@/log';
import { exportBugReportDiagnosticsBundle } from './bugReportExport';
const fs = await vi.hoisted(async () => {
  const { createExpoFileSystemFileMock } = await import('@/dev/testkit/mocks/expoFileSystem');
  return createExpoFileSystemFileMock();
});
const sdk = vi.hoisted(() => ({ share: vi.fn(), available: true }));
vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return { ...await createReactNativeWebMock(), Platform: { OS: 'ios' } };
});
vi.mock('expo-file-system', () => fs.module);
vi.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/', EncodingType: { UTF8: 'utf8' },
  writeAsStringAsync: async (uri: string, text: string) => { fs.files.set(uri, [...new TextEncoder().encode(text)]); },
}));
vi.mock('expo-sharing', () => ({ isAvailableAsync: async () => sdk.available, shareAsync: sdk.share }));
afterEach(() => {
  fs.files.clear();
  vi.clearAllMocks();
  sdk.share.mockReset();
  sdk.available = true;
});
const input = {
  exportedAt: '2026-09-26T00:00:00.000Z',
  environment: { appVersion: '0.3.0', platform: 'ios', deploymentType: 'cloud' },
  artifacts: [{ filename: 'logs.txt', sourceKind: 'ui-mobile' as const, contentType: 'text/plain', content: 'synthetic log' }],
} satisfies Parameters<typeof exportBugReportDiagnosticsBundle>[0];
describe('exportBugReportDiagnosticsBundle', () => {
  it('shares one serialized bundle and removes completed iOS custody', async () => {
    sdk.share.mockImplementation(async (uri: string, options: { mimeType?: string; UTI?: string; dialogTitle?: string }) => {
      const contents = JSON.parse(new TextDecoder().decode(new Uint8Array(fs.files.get(uri)!)));
      expect(contents.schemaVersion).toBe(1);
      expect(contents.exportedAt).toBe(input.exportedAt);
      expect(JSON.stringify(contents)).toContain('synthetic log');
      expect(options).toMatchObject({ mimeType: 'application/json', UTI: 'public.json' });
      expect(options.dialogTitle).toBeTruthy();
      expect(uri).toContain('/happier-downloads/');
    });
    await exportBugReportDiagnosticsBundle(input);
    expect(sdk.share).toHaveBeenCalledOnce();
    expect(fs.files.size).toBe(0);
  });
  it('retains both sharing and cleanup fault diagnostics when cleanup also rejects', async () => {
    const priorLogs = log.getLogs().length;
    sdk.share.mockRejectedValueOnce(new Error('synthetic_share_fault'));
    fs.deleteFile.mockImplementationOnce(() => { throw new Error('synthetic_cleanup_fault'); });
    await expect(exportBugReportDiagnosticsBundle(input)).rejects.toThrow();
    const diagnostics = log.getLogs().slice(priorLogs).join(' ');
    expect(diagnostics).toContain('synthetic_share_fault');
    expect(diagnostics).toContain('synthetic_cleanup_fault');
  });
});
