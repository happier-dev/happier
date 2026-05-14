export const EOL = '\n';

export function arch(): string {
  return 'unknown';
}

export function homedir(): string {
  return '/';
}

export function hostname(): string {
  return '';
}

export function platform(): string {
  return 'unknown';
}

export function release(): string {
  return '';
}

export function tmpdir(): string {
  return '/tmp';
}

export function type(): string {
  return '';
}

export function userInfo(): { username: string; homedir: string; shell: null } {
  return {
    username: '',
    homedir: homedir(),
    shell: null,
  };
}

export default {
  EOL,
  arch,
  homedir,
  hostname,
  platform,
  release,
  tmpdir,
  type,
  userInfo,
};
