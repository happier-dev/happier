import { fetchJson } from './http';

export async function fetchAccountId(baseUrl: string, token: string): Promise<string> {
  const res = await fetchJson<any>(`${baseUrl}/v1/account/profile`, {
    headers: { Authorization: `Bearer ${token}` },
    timeoutMs: 15_000,
  });
  if (res.status !== 200 || typeof res.data?.id !== 'string' || res.data.id.length === 0) {
    throw new Error(`Failed to fetch account profile (status=${res.status})`);
  }
  return res.data.id;
}

export async function setUsername(baseUrl: string, token: string, username: string): Promise<void> {
  const res = await fetchJson<any>(`${baseUrl}/v1/account/username`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ username }),
    timeoutMs: 15_000,
  });
  if (res.status !== 200) {
    throw new Error(`Failed to set username ${username} (status=${res.status})`);
  }
}

export async function addFriend(baseUrl: string, token: string, uid: string): Promise<void> {
  const res = await fetchJson<any>(`${baseUrl}/v1/friends/add`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ uid }),
    timeoutMs: 15_000,
  });
  if (res.status !== 200) {
    throw new Error(`Failed to add friend ${uid} (status=${res.status})`);
  }
}

