type FormatUsageCurrencyOptions = Readonly<{
    minimumFractionDigits?: number;
    maximumFractionDigits?: number;
}>;

export function formatUsageCurrency(
    value: number,
    currency: string,
    options: FormatUsageCurrencyOptions = {},
): string {
    const maximumFractionDigits = options.maximumFractionDigits ?? (Math.abs(value) >= 100 ? 0 : 2);
    const minimumFractionDigits = options.minimumFractionDigits ?? 0;

    try {
        return new Intl.NumberFormat(undefined, {
            style: 'currency',
            currency,
            minimumFractionDigits,
            maximumFractionDigits,
        }).format(value);
    } catch {
        return `${currency} ${value.toFixed(maximumFractionDigits)}`;
    }
}
