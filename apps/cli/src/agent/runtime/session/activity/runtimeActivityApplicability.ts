export type RuntimeActivityApplicability = 'supported' | 'unavailable' | 'not_applicable';

export function resolveRuntimeActivityApplicability(
  declaration: unknown,
  options: Readonly<{ declarationPresent?: boolean }> = {},
): RuntimeActivityApplicability {
  const declarationPresent = options.declarationPresent ?? (declaration !== undefined);
  if (!declarationPresent) return 'not_applicable';
  switch (declaration) {
    case 'supported':
    case 'unavailable':
    case 'not_applicable':
      return declaration;
    default:
      throw new TypeError(
        'Runtime Activity applicability must be supported, unavailable, or not_applicable when declared',
      );
  }
}
