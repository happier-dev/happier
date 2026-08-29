import { rm } from 'node:fs/promises';
import { isAbsolute, parse, resolve } from 'node:path';

import { assertLayoutPath, type PersonalHomeRuntimeLayout } from './layout.js';

export class PersonalHomeEraseError extends Error {
  readonly code: 'confirmation_required' | 'unsafe_data_root';

  constructor(code: PersonalHomeEraseError['code'], message: string) {
    super(message);
    this.name = 'PersonalHomeEraseError';
    this.code = code;
  }
}

export type PersonalHomeEraseResult = Readonly<{
  removedPaths: readonly string[];
}>;

function resolveValidatedDataRoot(layout: PersonalHomeRuntimeLayout): string {
  const dataRoot = assertLayoutPath(layout, layout.dataDir);
  if (!isAbsolute(dataRoot) || dataRoot === parse(dataRoot).root) {
    throw new PersonalHomeEraseError('unsafe_data_root', 'Refusing to erase an unsafe Personal Home data root.');
  }
  return dataRoot;
}

export async function erasePersonalHomeData(params: Readonly<{
  layout: PersonalHomeRuntimeLayout;
  confirmed: boolean;
}>): Promise<PersonalHomeEraseResult> {
  if (params.confirmed !== true) {
    throw new PersonalHomeEraseError(
      'confirmation_required',
      'Explicit confirmation is required to erase Personal Home data.',
    );
  }

  const dataRoot = resolveValidatedDataRoot(params.layout);
  await rm(resolve(dataRoot), { recursive: true, force: true });
  return { removedPaths: [dataRoot] };
}
