import type { Capability } from '@/capabilities/service';
import { retiredAgyAcpServerCapability } from './retiredAcpServerCapability';

export const capabilities: ReadonlyArray<Capability> = [
  retiredAgyAcpServerCapability,
];
