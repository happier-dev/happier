import type { StderrContext, StderrResult } from '@/agent/transport/TransportHandler';
import { DefaultTransport } from '@/agent/transport';

function isOptionalKiroNotificationMethodNotFound(trimmed: string): boolean {
  const lower = trimmed.toLowerCase();
  return (
    lower.includes('error handling notification')
    && trimmed.includes('_kiro.dev/')
    && lower.includes('method not found')
  );
}

export class KiroTransport extends DefaultTransport {
  constructor() {
    super('kiro');
  }

  override handleStderr(text: string, context: StderrContext): StderrResult {
    const trimmed = text.trim();
    if (!trimmed) return { message: null, suppress: true };
    if (isOptionalKiroNotificationMethodNotFound(trimmed)) {
      return { message: null, suppress: true };
    }
    return super.handleStderr(text, context);
  }
}
