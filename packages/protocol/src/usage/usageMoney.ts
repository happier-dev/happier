/** Exact base-ten arithmetic over validated rates, tokens and observed money. */
export type ExactUsageMoney = Readonly<{ units: bigint; scale: number }>;
const exactZero: ExactUsageMoney = Object.freeze({ units: 0n, scale: 0 });

function normalize(units: bigint, scale: number): ExactUsageMoney {
  if (units === 0n) return exactZero;
  while (scale > 0 && units % 10n === 0n) { units /= 10n; scale--; }
  return { units, scale };
}

/** Number's canonical decimal text is the boundary's admitted precision, including exponents. */
export function usageMoneyFromNumber(value: number): ExactUsageMoney {
  if (value === 0) return exactZero;
  // Only safe integers have the same BigInt value and canonical decimal text.
  if (Number.isSafeInteger(value)) return { units: BigInt(value), scale: 0 };
  const [coefficient, exponent] = value.toString().toLowerCase().split('e');
  const [integer, fraction = ''] = coefficient!.split('.');
  const units = BigInt(integer! + fraction);
  const scale = fraction.length - Number(exponent ?? 0);
  return normalize(scale < 0 ? units * 10n ** BigInt(-scale) : units, Math.max(0, scale));
}

export function addUsageMoney(left: ExactUsageMoney, right: ExactUsageMoney): ExactUsageMoney {
  if (left.scale === 0 && right.scale === 0) {
    if (left.units === 0n) return right;
    if (right.units === 0n) return left;
    return { units: left.units + right.units, scale: 0 };
  }
  if (left.scale === right.scale) return normalize(left.units + right.units, left.scale);
  const scale = Math.max(left.scale, right.scale);
  return normalize(scaleMoneyUnits(left.units, left.scale, scale) + scaleMoneyUnits(right.units, right.scale, scale), scale);
}

function scaleMoneyUnits(units: bigint, from: number, to: number): bigint {
  return from === to ? units : units * 10n ** BigInt(to - from);
}

/** A group keeps scaled integer operands and normalizes only when it publishes. */
export function createUsageMoneyAccumulator(initial: ExactUsageMoney) {
  let { units, scale } = initial;
  return {
    add(amount: ExactUsageMoney): void {
      const nextUnits = amount.units;
      if (nextUnits === 0n) return;
      const nextScale = amount.scale;
      const commonScale = Math.max(scale, nextScale);
      units = scaleMoneyUnits(units, scale, commonScale) + scaleMoneyUnits(nextUnits, nextScale, commonScale);
      scale = commonScale;
    },
    isZero(): boolean { return units === 0n; },
    value(): ExactUsageMoney { return normalize(units, scale); },
  };
}

export function subtractUsageMoney(left: ExactUsageMoney, right: ExactUsageMoney): ExactUsageMoney {
  return addUsageMoney(left, { units: -right.units, scale: right.scale });
}

export function multiplyUsageMoney(left: ExactUsageMoney, right: ExactUsageMoney): ExactUsageMoney {
  return normalize(left.units * right.units, left.scale + right.scale);
}

export function divideUsageMoneyByMillion(value: ExactUsageMoney): ExactUsageMoney {
  return normalize(value.units, value.scale + 6);
}

/** Convert the final decimal once; neither operand is rounded before an exact operation. */
export function usageMoneyToNumber(value: ExactUsageMoney): number {
  if (value.scale === 0) return Number(value.units);
  return Number(`${value.units}e-${value.scale}`);
}

const usageMoneyBasis = Symbol('usageMoneyBasis');
type MoneyEntry = Readonly<{ publicValue: number; exact: ExactUsageMoney }>;
type MoneyCarrier = { [usageMoneyBasis]?: Readonly<Record<string, MoneyEntry>> };

export type SerializedUsageMoneyProvenance = Readonly<Record<string, Readonly<{ units: string; scale: number }>>>;

/** Persist only the exact operands hidden behind public Numbers in an internal checkpoint. */
export function serializeUsageMoneyProvenance(value: object): SerializedUsageMoneyProvenance {
  const entries = (value as MoneyCarrier)[usageMoneyBasis];
  return Object.fromEntries(Object.entries(entries ?? {}).flatMap(([field, entry]) =>
    Object.is(Reflect.get(value, field), entry.publicValue)
      ? [[field, { units: entry.exact.units.toString(), scale: entry.exact.scale }]] : []));
}

/** Restore the owner's exact operand sidecar after JSON has revived the public object. */
export function restoreUsageMoneyProvenance<T extends object>(value: T,
  serialized: SerializedUsageMoneyProvenance): T {
  return withUsageMoney(value, Object.fromEntries(Object.entries(serialized).map(([field, exact]) =>
    [field, { units: BigInt(exact.units), scale: exact.scale }])));
}

/** Integer token addition may bypass decimal work only without retained sub-number precision. */
export function hasUsageMoneyProvenance(value: object): boolean {
  return (value as MoneyCarrier)[usageMoneyBasis] !== undefined;
}

/** Spreads retain exact provenance; replacing a numeric field invalidates its old provenance. */
export function readUsageMoney(value: object, field: string, fallback: number): ExactUsageMoney {
  const entry = (value as MoneyCarrier)[usageMoneyBasis]?.[field];
  return entry && Object.is(entry.publicValue, fallback) ? entry.exact : usageMoneyFromNumber(fallback);
}

/** Rename an already admitted exact operand without parsing its public Number again. */
export function transferUsageMoney<T extends object>(source: object, sourceField: string, publicValue: number,
  target: T, targetField: string): T {
  const entry = (source as MoneyCarrier)[usageMoneyBasis]?.[sourceField];
  if (!entry || !Object.is(entry.publicValue, publicValue)
    || !Object.is(Reflect.get(target, targetField), publicValue)) return target;
  return { ...target, [usageMoneyBasis]: { ...(target as MoneyCarrier)[usageMoneyBasis], [targetField]: entry } };
}

/** Internal enumerable Symbol metadata survives ordinary spreads and is ignored by JSON.
 * Keep admitted decimals directly: consumers must not parse their public Number
 * again at every aggregation. Exact safe integers need no extra provenance.
 */
export function withUsageMoney<T extends object>(value: T, fields: Readonly<Partial<Record<string, ExactUsageMoney>>>): T {
  const previous = (value as MoneyCarrier)[usageMoneyBasis];
  let entries: Record<string, MoneyEntry> | undefined;
  for (const [field, exact] of Object.entries(fields)) {
    const publicValue: unknown = Reflect.get(value, field);
    const existing = previous?.[field];
    if (exact && existing?.exact === exact && Object.is(existing.publicValue, publicValue)) continue;
    if (exact && typeof publicValue === 'number' && Number.isFinite(publicValue)
      && (!Number.isSafeInteger(publicValue) || subtractUsageMoney(exact, usageMoneyFromNumber(publicValue)).units !== 0n)) {
      entries ??= { ...previous };
      entries[field] = { publicValue, exact };
    } else if (existing) {
      entries ??= { ...previous };
      delete entries[field];
    }
  }
  if (!entries) return value;
  if (Object.keys(entries).length === 0) {
    if (!(usageMoneyBasis in value)) return value;
    const result = { ...value };
    Reflect.deleteProperty(result, usageMoneyBasis);
    return result;
  }
  return { ...value, [usageMoneyBasis]: entries };
}
