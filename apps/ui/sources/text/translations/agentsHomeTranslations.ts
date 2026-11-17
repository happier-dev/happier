// The Agents root home (S30 §6.2, lab t:agents): its purpose, Needs you, the "Try another agent" shelf and the
// Models destination. Mounted under `capabilities.agentsHome`.

type Machine = Readonly<{ machine: string }>;

export type AgentsHomeTranslation = Readonly<{
  purpose: string;
  needsTitle: string;
  needsSignIn: (params: Machine) => string;
  tryTitle: string;
  tryBody: string;
  modelsTitle: string;
  modelsBody: string;
}>;

const en: AgentsHomeTranslation = {
  purpose:
    'The coding agents you start sessions with, where they’re installed and how they sign in.',
  needsTitle: 'Needs you',
  needsSignIn: ({ machine }) =>
    `Sessions on ${machine} can’t start until you sign in`,
  tryTitle: 'Try another agent',
  tryBody: 'Each one starts sessions like the agents you have.',
  modelsTitle: 'Models for your agents',
  modelsBody:
    'Providers give your agents more models: one key for many, or a model server on your machines.',
};

export const agentsHomeTranslations = {
  en,
} as const satisfies Pick<Record<string, AgentsHomeTranslation>, 'en'>;
