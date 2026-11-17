// Copy of the one named-value row editor (environment variables, headers): `ValueRefRowsEditor`. Mounted under `capabilities.valueRows`.

export type ValueRefRowsTranslation = Readonly<{
  name: string;
  value: string;
  typeLabel: string;
  text: string;
  savedSecret: string;
  fromMachine: string;
  template: string;
  fromSession: string;
  chooseSecret: string;
  needsValue: string;
  more: (params: Readonly<{ name: string }>) => string;
  edit: string;
  remove: string;
  invalidEnvName: string;
  invalidHeaderName: string;
  duplicateName: string;
  invalidMachine: string;
}>;

const en: ValueRefRowsTranslation = {
  name: 'Name',
  value: 'Value',
  typeLabel: 'Value type',
  text: 'Text',
  savedSecret: 'Saved secret',
  fromMachine: 'From the machine',
  template: 'Template',
  fromSession: 'From the session',
  chooseSecret: 'Choose a saved secret',
  needsValue: 'Needs a value',
  more: ({ name }) => `More for ${name}`,
  edit: 'Edit…',
  remove: 'Remove',
  invalidEnvName: 'Use capital letters, digits and _ , starting with a letter.',
  invalidHeaderName: 'Use letters, digits and - only.',
  duplicateName: 'That name is already used.',
  invalidMachine: 'Name a variable on the machine, like ${HOME}.',
};

export const valueRefRowsTranslations = {
  en,
} as const;
