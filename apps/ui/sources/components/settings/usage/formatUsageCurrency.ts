type FormatUsageCurrencyOptions = Readonly<{
    minimumFractionDigits?: number;
    maximumFractionDigits?: number;
}>;

export function formatUsageCurrency(
    value: number,
    currency: string,
    options: FormatUsageCurrencyOptions = {},
): string {
    const { minimumFractionDigits = 0, maximumFractionDigits = 2 } = options;

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
