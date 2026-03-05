import { codexAcpDepCapability } from '@/capabilities/registry/depCodexAcp';
import type { Capability } from '@/capabilities/service';

export const capabilities: ReadonlyArray<Capability> = [
  codexAcpDepCapability,
];
