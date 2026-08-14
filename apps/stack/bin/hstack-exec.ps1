$ErrorActionPreference = 'Stop'

$invocation = @($args)
if ($invocation.Count -gt 0 -and $invocation[0] -eq '--local') {
    $invocation = @($invocation | Select-Object -Skip 1)
}
if ($invocation.Count -gt 0 -and $invocation[0].StartsWith('--script=')) {
    $script = $invocation[0].Substring('--script='.Length)
    $rest = @($invocation | Select-Object -Skip 1)
    if ($rest.Count -gt 0 -and $rest[0] -eq '--') {
        $rest = @($rest | Select-Object -Skip 1)
    }
    & corepack yarn -s $script @rest
    exit $LASTEXITCODE
}
if ($invocation.Count -gt 0 -and $invocation[0] -eq '--') {
    $invocation = @($invocation | Select-Object -Skip 1)
}
if ($invocation.Count -eq 0) {
    Write-Error '[preferred-execution] provide --script=NAME or COMMAND [ARG...] after --'
    exit 1
}
$command = $invocation[0]
$rest = @($invocation | Select-Object -Skip 1)
& $command @rest
exit $LASTEXITCODE
