import axios from 'axios';

export function readAxiosResponseErrorCode(error: unknown): string | null {
  if (!axios.isAxiosError(error)) return null;
  const data: unknown = error.response?.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const code = (data as Record<string, unknown>).error;
  return typeof code === 'string' && code.trim().length > 0 ? code.trim() : null;
}
