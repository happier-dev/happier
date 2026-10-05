const headings: Readonly<Record<string, readonly [string, string, string, string, string, string, string]>> = {
  en: ['The ask', 'The report', 'What changed', '{count} failed', 'Running', 'Passed', 'Activity'],
  ru: ['Запрос', 'Отчёт', 'Что изменилось', 'Ошибок: {count}', 'Выполняется', 'Успешно', 'Активность'],
  pl: ['Prośba', 'Zgłoszenie', 'Co się zmieniło', 'Niepowodzenia: {count}', 'W toku', 'Powodzenie', 'Aktywność'],
  es: ['La solicitud', 'El informe', 'Qué cambió', '{count} fallidos', 'En curso', 'Correcto', 'Actividad'],
  fr: ['La demande', 'Le signalement', 'Ce qui a changé', '{count} en échec', 'En cours', 'Réussi', 'Activité'],
  it: ['La richiesta', 'La segnalazione', 'Cosa è cambiato', '{count} non riusciti', 'In corso', 'Riuscito', 'Attività'],
  pt: ['O pedido', 'O relatório', 'O que mudou', '{count} falharam', 'Em andamento', 'Concluído', 'Atividade'],
  de: ['Die Anfrage', 'Der Bericht', 'Was sich geändert hat', '{count} fehlgeschlagen', 'Läuft', 'Bestanden', 'Aktivität'],
  ca: ['La petició', 'L’informe', 'Què ha canviat', '{count} han fallat', 'En curs', 'Correcte', 'Activitat'],
  'zh-Hans': ['请求', '报告', '变更内容', '{count} 项失败', '进行中', '通过', '活动'],
  'zh-Hant': ['請求', '報告', '變更內容', '{count} 項失敗', '進行中', '通過', '活動'],
  ja: ['依頼', '報告', '変更内容', '{count} 件失敗', '実行中', '成功', 'アクティビティ'],
};

const detailLabels: Readonly<Record<string, string>> = {
  en: 'Source detail', ru: 'Подробности источника', pl: 'Szczegóły źródła',
  es: 'Detalle de la fuente', fr: 'Détails de la source', it: 'Dettaglio della fonte',
  pt: 'Detalhes da fonte', de: 'Quelldetails', ca: 'Detall de la font',
  'zh-Hans': '来源详情', 'zh-Hant': '來源詳細資料', ja: 'ソースの詳細',
};

export function triageDetailStoryTranslations(locale: string): Readonly<Record<string, string>> {
  const values = headings[locale] ?? headings.en!;
  return {
    ...Object.fromEntries(['ask', 'report', 'changed', 'failed', 'running', 'passed', 'activity']
      .map((key, index) => [`plugins.triage.detailStory.${key}`, values[index]!])),
    'plugins.triage.detailStory.detail': detailLabels[locale] ?? detailLabels.en!,
  };
}
