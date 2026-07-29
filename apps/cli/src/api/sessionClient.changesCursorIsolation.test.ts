import { describe, expect, it, vi } from 'vitest';
import axios from 'axios';

const { readAccountChangesCursor, writeAccountChangesCursor } = vi.hoisted(() => ({
  readAccountChangesCursor: vi.fn(async () => 0),
  writeAccountChangesCursor: vi.fn(async () => {}),
}));

vi.mock('@/persistence', () => ({
  readAccountChangesCursor,
  writeAccountChangesCursor,
}));

vi.mock('axios');

describe('session client changes cursor isolation', () => {
});
