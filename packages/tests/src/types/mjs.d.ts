declare module '*.plan.mjs' {
  export type ExtendedDbProvider = 'postgres' | 'mysql';
  export type ExtendedDbMode = 'e2e' | 'contract' | 'extended' | 'session-system-record-upgrade';

  export type DbContainerPlan = {
    db: ExtendedDbProvider;
    name: string;
    image: string;
    env: Record<string, string>;
    ports: { containerPort: number; publishSpec: string };
    healthCmd: string;
  };

  export type ExtendedDbCommandStep = {
    kind:
      | 'prebuild-cli-shared'
      | 'prebuild-cli'
      | 'e2e'
      | 'migrate'
      | 'contract'
      | 'mysql-voice-identity-upgrade-contract'
      | 'session-system-record-upgrade-seed'
      | 'session-system-record-migrate-first'
      | 'session-system-record-migrate-second'
      | 'session-system-record-upgrade-verify'
      | 'session-system-record-board-contract';
    command: string;
    args: string[];
    env: Record<string, string>;
  };

  export function sanitizeDockerEnv(env: Record<string, string | undefined> | null | undefined): Record<string, string | undefined>;
  export function buildDbContainerPlan(params: { db: ExtendedDbProvider; name?: string | null }): DbContainerPlan;
  export function parseDockerPortLine(line: string): { host: string; port: number };
  export function buildDatabaseUrlForContainer(params: { db: ExtendedDbProvider; host: string; port: number }): string;
  export function buildExtendedDbCommandPlan(params: {
    db: ExtendedDbProvider;
    mode: ExtendedDbMode;
    databaseUrl: string;
    contractFile?: string;
    containerId?: string;
  }): ExtendedDbCommandStep[];
}
