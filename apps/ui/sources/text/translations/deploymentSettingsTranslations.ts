import type { SupportedLanguage } from '../_all';

/** Environment → Settings (Backups destination and keep counts, Checks): copy added by DEPLOY-COMPOSE-1107 lane L-D. */
type DeploymentSettingsTranslations = Readonly<{
  destinationS3: (params: { region: string }) => string;
  destinationS3NoRegion: string;
  destinationTest: string;
  destinationReachable: string;
  destinationRepositoryMissing: string;
  destinationNativeFailed: string;
  destinationLocked: string;
  destinationPasswordIncorrect: string;
  destinationRetry: string;
  keepTitle: string;
  keepChange: string;
  keepDescription: string;
  keepLast: string;
  keepDaily: string;
  keepWeekly: string;
  keepMonthly: string;
  keepSave: string;
  keepCancel: string;
  keepInvalid: string;
  pruneTitle: string;
  pruneDescription: string;
  pruneAction: string;
  pruned: (params: { count: number }) => string;
  prunedNothing: string;
  addCheck: string;
  addCheckUnavailable: string;
}>;

export const deploymentSettingsTranslations = {
  en: {
    destinationS3: ({ region }) => `S3 in ${region}`,
    destinationS3NoRegion: 'S3 storage',
    destinationTest: 'Test',
    destinationReachable: 'Reachable · tested just now',
    destinationRepositoryMissing:
      'No backups found there · check the bucket and prefix',
    destinationNativeFailed:
      "The destination didn't answer · check its address",
    destinationLocked: 'Another backup is using it · Retry when it finishes',
    destinationPasswordIncorrect: "The repository password doesn't match",
    destinationRetry: "The test didn't finish · Retry",
    keepTitle: 'Keep',
    keepChange: 'Change',
    keepDescription:
      'After each backup, older ones past these counts are removed. Leave them all empty to keep every backup.',
    keepLast: 'Most recent',
    keepDaily: 'Daily',
    keepWeekly: 'Weekly',
    keepMonthly: 'Monthly',
    keepSave: 'Save',
    keepCancel: 'Cancel',
    keepInvalid: 'Use whole numbers above zero',
    pruneTitle: 'Remove old backups now',
    pruneDescription:
      'Removes the backups past what you keep, without waiting for the next backup.',
    pruneAction: 'Remove',
    pruned: ({ count }) =>
      count === 1 ? 'Removed 1 old backup' : `Removed ${count} old backups`,
    prunedNothing: 'Nothing past what you keep',
    addCheck: 'Add check',
    addCheckUnavailable:
      "Checks can't be set up from here · open the Machine's Services page",
  },
  ru: {
    destinationS3: ({ region }) => `S3 в ${region}`,
    destinationS3NoRegion: 'Хранилище S3',
    destinationTest: 'Проверить',
    destinationReachable: 'Доступно · проверено только что',
    destinationRepositoryMissing:
      'Резервных копий там нет · проверьте бакет и префикс',
    destinationNativeFailed: 'Хранилище не ответило · проверьте адрес',
    destinationLocked:
      'Его использует другое копирование · повторите, когда оно закончится',
    destinationPasswordIncorrect: 'Пароль репозитория не подходит',
    destinationRetry: 'Проверка не завершилась · повторите',
    keepTitle: 'Хранить',
    keepChange: 'Изменить',
    keepDescription:
      'После каждого копирования более старые копии сверх этих чисел удаляются. Оставьте все поля пустыми, чтобы хранить все копии.',
    keepLast: 'Последние',
    keepDaily: 'Ежедневные',
    keepWeekly: 'Еженедельные',
    keepMonthly: 'Ежемесячные',
    keepSave: 'Сохранить',
    keepCancel: 'Отмена',
    keepInvalid: 'Используйте целые числа больше нуля',
    pruneTitle: 'Удалить старые копии сейчас',
    pruneDescription:
      'Удаляет копии сверх сохраняемых, не дожидаясь следующего копирования.',
    pruneAction: 'Удалить',
    pruned: ({ count }) => `Удалено старых копий: ${count}`,
    prunedNothing: 'Нечего удалять',
    addCheck: 'Добавить проверку',
    addCheckUnavailable:
      'Проверки нельзя настроить отсюда · откройте страницу служб машины',
  },
  pl: {
    destinationS3: ({ region }) => `S3 w ${region}`,
    destinationS3NoRegion: 'Magazyn S3',
    destinationTest: 'Testuj',
    destinationReachable: 'Dostępne · sprawdzono przed chwilą',
    destinationRepositoryMissing: 'Brak tam kopii · sprawdź zasobnik i prefiks',
    destinationNativeFailed:
      'Miejsce docelowe nie odpowiedziało · sprawdź adres',
    destinationLocked: 'Używa go inna kopia · ponów, gdy się skończy',
    destinationPasswordIncorrect: 'Hasło repozytorium się nie zgadza',
    destinationRetry: 'Test się nie zakończył · ponów',
    keepTitle: 'Zachowuj',
    keepChange: 'Zmień',
    keepDescription:
      'Po każdej kopii starsze ponad te liczby są usuwane. Zostaw wszystkie puste, aby zachować każdą kopię.',
    keepLast: 'Najnowsze',
    keepDaily: 'Dzienne',
    keepWeekly: 'Tygodniowe',
    keepMonthly: 'Miesięczne',
    keepSave: 'Zapisz',
    keepCancel: 'Anuluj',
    keepInvalid: 'Użyj liczb całkowitych większych od zera',
    pruneTitle: 'Usuń stare kopie teraz',
    pruneDescription:
      'Usuwa kopie ponad to, co zachowujesz, bez czekania na następną kopię.',
    pruneAction: 'Usuń',
    pruned: ({ count }) => `Usunięto stare kopie: ${count}`,
    prunedNothing: 'Nic ponad to, co zachowujesz',
    addCheck: 'Dodaj sprawdzenie',
    addCheckUnavailable:
      'Sprawdzeń nie można tu skonfigurować · otwórz stronę usług maszyny',
  },
  es: {
    destinationS3: ({ region }) => `S3 en ${region}`,
    destinationS3NoRegion: 'Almacenamiento S3',
    destinationTest: 'Probar',
    destinationReachable: 'Accesible · probado ahora',
    destinationRepositoryMissing:
      'No hay copias ahí · revisa el bucket y el prefijo',
    destinationNativeFailed: 'El destino no respondió · revisa su dirección',
    destinationLocked: 'Otra copia lo está usando · reintenta cuando termine',
    destinationPasswordIncorrect: 'La contraseña del repositorio no coincide',
    destinationRetry: 'La prueba no terminó · reintenta',
    keepTitle: 'Conservar',
    keepChange: 'Cambiar',
    keepDescription:
      'Tras cada copia se eliminan las más antiguas que superen estas cifras. Déjalas vacías para conservar todas.',
    keepLast: 'Más recientes',
    keepDaily: 'Diarias',
    keepWeekly: 'Semanales',
    keepMonthly: 'Mensuales',
    keepSave: 'Guardar',
    keepCancel: 'Cancelar',
    keepInvalid: 'Usa números enteros mayores que cero',
    pruneTitle: 'Eliminar copias antiguas ahora',
    pruneDescription:
      'Elimina las copias que superan lo que conservas, sin esperar a la próxima copia.',
    pruneAction: 'Eliminar',
    pruned: ({ count }) =>
      count === 1
        ? 'Se eliminó 1 copia antigua'
        : `Se eliminaron ${count} copias antiguas`,
    prunedNothing: 'No hay nada que eliminar',
    addCheck: 'Añadir comprobación',
    addCheckUnavailable:
      'Las comprobaciones no se configuran aquí · abre la página de servicios de la máquina',
  },
  fr: {
    destinationS3: ({ region }) => `S3 en ${region}`,
    destinationS3NoRegion: 'Stockage S3',
    destinationTest: 'Tester',
    destinationReachable: 'Joignable · testé à l’instant',
    destinationRepositoryMissing:
      'Aucune sauvegarde à cet endroit · vérifiez le bucket et le préfixe',
    destinationNativeFailed:
      'La destination n’a pas répondu · vérifiez son adresse',
    destinationLocked:
      'Une autre sauvegarde l’utilise · réessayez quand elle sera terminée',
    destinationPasswordIncorrect: 'Le mot de passe du dépôt ne correspond pas',
    destinationRetry: 'Le test n’a pas abouti · réessayez',
    keepTitle: 'Conserver',
    keepChange: 'Modifier',
    keepDescription:
      'Après chaque sauvegarde, les plus anciennes au-delà de ces nombres sont supprimées. Laissez tout vide pour tout conserver.',
    keepLast: 'Plus récentes',
    keepDaily: 'Quotidiennes',
    keepWeekly: 'Hebdomadaires',
    keepMonthly: 'Mensuelles',
    keepSave: 'Enregistrer',
    keepCancel: 'Annuler',
    keepInvalid: 'Utilisez des nombres entiers supérieurs à zéro',
    pruneTitle: 'Supprimer les anciennes sauvegardes',
    pruneDescription:
      'Supprime les sauvegardes au-delà de ce que vous conservez, sans attendre la prochaine.',
    pruneAction: 'Supprimer',
    pruned: ({ count }) =>
      count === 1
        ? '1 ancienne sauvegarde supprimée'
        : `${count} anciennes sauvegardes supprimées`,
    prunedNothing: 'Rien au-delà de ce que vous conservez',
    addCheck: 'Ajouter une vérification',
    addCheckUnavailable:
      'Les vérifications ne se configurent pas ici · ouvrez la page Services de la machine',
  },
  it: {
    destinationS3: ({ region }) => `S3 in ${region}`,
    destinationS3NoRegion: 'Archiviazione S3',
    destinationTest: 'Prova',
    destinationReachable: 'Raggiungibile · provato ora',
    destinationRepositoryMissing:
      'Nessun backup lì · controlla bucket e prefisso',
    destinationNativeFailed:
      'La destinazione non ha risposto · controlla l’indirizzo',
    destinationLocked: 'Un altro backup la sta usando · riprova quando finisce',
    destinationPasswordIncorrect: 'La password del repository non corrisponde',
    destinationRetry: 'La prova non è terminata · riprova',
    keepTitle: 'Conserva',
    keepChange: 'Modifica',
    keepDescription:
      'Dopo ogni backup, quelli più vecchi oltre questi numeri vengono rimossi. Lascia tutto vuoto per conservarli tutti.',
    keepLast: 'Più recenti',
    keepDaily: 'Giornalieri',
    keepWeekly: 'Settimanali',
    keepMonthly: 'Mensili',
    keepSave: 'Salva',
    keepCancel: 'Annulla',
    keepInvalid: 'Usa numeri interi maggiori di zero',
    pruneTitle: 'Rimuovi ora i backup vecchi',
    pruneDescription:
      'Rimuove i backup oltre quelli che conservi, senza attendere il prossimo backup.',
    pruneAction: 'Rimuovi',
    pruned: ({ count }) =>
      count === 1
        ? 'Rimosso 1 backup vecchio'
        : `Rimossi ${count} backup vecchi`,
    prunedNothing: 'Niente oltre quelli che conservi',
    addCheck: 'Aggiungi controllo',
    addCheckUnavailable:
      'I controlli non si configurano qui · apri la pagina Servizi della macchina',
  },
  pt: {
    destinationS3: ({ region }) => `S3 em ${region}`,
    destinationS3NoRegion: 'Armazenamento S3',
    destinationTest: 'Testar',
    destinationReachable: 'Acessível · testado agora',
    destinationRepositoryMissing:
      'Nenhum backup lá · verifique o bucket e o prefixo',
    destinationNativeFailed: 'O destino não respondeu · verifique o endereço',
    destinationLocked:
      'Outro backup está a usá-lo · tente de novo quando terminar',
    destinationPasswordIncorrect:
      'A palavra-passe do repositório não corresponde',
    destinationRetry: 'O teste não terminou · tente de novo',
    keepTitle: 'Manter',
    keepChange: 'Alterar',
    keepDescription:
      'Após cada backup, os mais antigos além destes números são removidos. Deixe tudo vazio para manter todos.',
    keepLast: 'Mais recentes',
    keepDaily: 'Diários',
    keepWeekly: 'Semanais',
    keepMonthly: 'Mensais',
    keepSave: 'Guardar',
    keepCancel: 'Cancelar',
    keepInvalid: 'Use números inteiros maiores que zero',
    pruneTitle: 'Remover backups antigos agora',
    pruneDescription:
      'Remove os backups além do que mantém, sem esperar pelo próximo backup.',
    pruneAction: 'Remover',
    pruned: ({ count }) =>
      count === 1
        ? '1 backup antigo removido'
        : `${count} backups antigos removidos`,
    prunedNothing: 'Nada além do que mantém',
    addCheck: 'Adicionar verificação',
    addCheckUnavailable:
      'As verificações não se configuram aqui · abra a página Serviços da máquina',
  },
  ca: {
    destinationS3: ({ region }) => `S3 a ${region}`,
    destinationS3NoRegion: 'Emmagatzematge S3',
    destinationTest: 'Prova',
    destinationReachable: 'Accessible · provat ara',
    destinationRepositoryMissing:
      'No hi ha còpies allà · revisa el bucket i el prefix',
    destinationNativeFailed: 'La destinació no ha respost · revisa l’adreça',
    destinationLocked:
      'Una altra còpia l’està fent servir · torna-ho a provar quan acabi',
    destinationPasswordIncorrect: 'La contrasenya del repositori no coincideix',
    destinationRetry: 'La prova no ha acabat · torna-ho a provar',
    keepTitle: 'Conserva',
    keepChange: 'Canvia',
    keepDescription:
      'Després de cada còpia, s’eliminen les més antigues que superin aquestes xifres. Deixa-ho tot buit per conservar-les totes.',
    keepLast: 'Més recents',
    keepDaily: 'Diàries',
    keepWeekly: 'Setmanals',
    keepMonthly: 'Mensuals',
    keepSave: 'Desa',
    keepCancel: 'Cancel·la',
    keepInvalid: 'Fes servir nombres enters més grans que zero',
    pruneTitle: 'Elimina ara les còpies antigues',
    pruneDescription:
      'Elimina les còpies que superen el que conserves, sense esperar la propera còpia.',
    pruneAction: 'Elimina',
    pruned: ({ count }) =>
      count === 1
        ? 'S’ha eliminat 1 còpia antiga'
        : `S’han eliminat ${count} còpies antigues`,
    prunedNothing: 'No hi ha res per eliminar',
    addCheck: 'Afegeix una comprovació',
    addCheckUnavailable:
      'Les comprovacions no es configuren aquí · obre la pàgina Serveis de la màquina',
  },
  de: {
    destinationS3: ({ region }) => `S3 in ${region}`,
    destinationS3NoRegion: 'S3-Speicher',
    destinationTest: 'Testen',
    destinationReachable: 'Erreichbar · gerade getestet',
    destinationRepositoryMissing:
      'Dort liegen keine Backups · Bucket und Präfix prüfen',
    destinationNativeFailed: 'Das Ziel hat nicht geantwortet · Adresse prüfen',
    destinationLocked:
      'Ein anderes Backup nutzt es · erneut versuchen, wenn es fertig ist',
    destinationPasswordIncorrect: 'Das Repository-Passwort stimmt nicht',
    destinationRetry: 'Der Test wurde nicht abgeschlossen · erneut versuchen',
    keepTitle: 'Behalten',
    keepChange: 'Ändern',
    keepDescription:
      'Nach jedem Backup werden ältere über diese Anzahl hinaus entfernt. Alles leer lassen, um jedes Backup zu behalten.',
    keepLast: 'Neueste',
    keepDaily: 'Täglich',
    keepWeekly: 'Wöchentlich',
    keepMonthly: 'Monatlich',
    keepSave: 'Speichern',
    keepCancel: 'Abbrechen',
    keepInvalid: 'Ganze Zahlen größer als null verwenden',
    pruneTitle: 'Alte Backups jetzt entfernen',
    pruneDescription:
      'Entfernt Backups über das Behaltene hinaus, ohne auf das nächste Backup zu warten.',
    pruneAction: 'Entfernen',
    pruned: ({ count }) =>
      count === 1
        ? '1 altes Backup entfernt'
        : `${count} alte Backups entfernt`,
    prunedNothing: 'Nichts über das Behaltene hinaus',
    addCheck: 'Prüfung hinzufügen',
    addCheckUnavailable:
      'Prüfungen lassen sich hier nicht einrichten · Dienste-Seite der Maschine öffnen',
  },
  'zh-Hans': {
    destinationS3: ({ region }) => `位于 ${region} 的 S3`,
    destinationS3NoRegion: 'S3 存储',
    destinationTest: '测试',
    destinationReachable: '可访问 · 刚刚测试',
    destinationRepositoryMissing: '那里没有备份 · 请检查存储桶和前缀',
    destinationNativeFailed: '目标没有响应 · 请检查地址',
    destinationLocked: '另一个备份正在使用它 · 完成后重试',
    destinationPasswordIncorrect: '仓库密码不匹配',
    destinationRetry: '测试未完成 · 重试',
    keepTitle: '保留',
    keepChange: '更改',
    keepDescription:
      '每次备份后，超出这些数量的旧备份会被移除。全部留空则保留所有备份。',
    keepLast: '最近',
    keepDaily: '每日',
    keepWeekly: '每周',
    keepMonthly: '每月',
    keepSave: '保存',
    keepCancel: '取消',
    keepInvalid: '请使用大于零的整数',
    pruneTitle: '立即移除旧备份',
    pruneDescription: '移除超出保留数量的备份，无需等待下一次备份。',
    pruneAction: '移除',
    pruned: ({ count }) => `已移除 ${count} 个旧备份`,
    prunedNothing: '没有超出保留数量的备份',
    addCheck: '添加检查',
    addCheckUnavailable: '无法在此设置检查 · 请打开机器的服务页面',
  },
  'zh-Hant': {
    destinationS3: ({ region }) => `位於 ${region} 的 S3`,
    destinationS3NoRegion: 'S3 儲存',
    destinationTest: '測試',
    destinationReachable: '可存取 · 剛剛測試',
    destinationRepositoryMissing: '那裡沒有備份 · 請檢查儲存桶和前綴',
    destinationNativeFailed: '目標沒有回應 · 請檢查位址',
    destinationLocked: '另一個備份正在使用它 · 完成後重試',
    destinationPasswordIncorrect: '儲存庫密碼不符',
    destinationRetry: '測試未完成 · 重試',
    keepTitle: '保留',
    keepChange: '變更',
    keepDescription:
      '每次備份後，超出這些數量的舊備份會被移除。全部留空則保留所有備份。',
    keepLast: '最近',
    keepDaily: '每日',
    keepWeekly: '每週',
    keepMonthly: '每月',
    keepSave: '儲存',
    keepCancel: '取消',
    keepInvalid: '請使用大於零的整數',
    pruneTitle: '立即移除舊備份',
    pruneDescription: '移除超出保留數量的備份，無需等待下一次備份。',
    pruneAction: '移除',
    pruned: ({ count }) => `已移除 ${count} 個舊備份`,
    prunedNothing: '沒有超出保留數量的備份',
    addCheck: '新增檢查',
    addCheckUnavailable: '無法在此設定檢查 · 請開啟機器的服務頁面',
  },
  ja: {
    destinationS3: ({ region }) => `${region} の S3`,
    destinationS3NoRegion: 'S3 ストレージ',
    destinationTest: 'テスト',
    destinationReachable: '到達可能 · たった今テスト済み',
    destinationRepositoryMissing:
      'バックアップが見つかりません · バケットとプレフィックスを確認',
    destinationNativeFailed: '保存先が応答しません · アドレスを確認',
    destinationLocked: '別のバックアップが使用中 · 終わったら再試行',
    destinationPasswordIncorrect: 'リポジトリのパスワードが一致しません',
    destinationRetry: 'テストが完了しませんでした · 再試行',
    keepTitle: '保持',
    keepChange: '変更',
    keepDescription:
      '各バックアップの後、これらの数を超えた古いバックアップは削除されます。すべて空欄ならすべて保持します。',
    keepLast: '最新',
    keepDaily: '日次',
    keepWeekly: '週次',
    keepMonthly: '月次',
    keepSave: '保存',
    keepCancel: 'キャンセル',
    keepInvalid: '0 より大きい整数を使用してください',
    pruneTitle: '古いバックアップを今すぐ削除',
    pruneDescription:
      '次のバックアップを待たずに、保持数を超えたバックアップを削除します。',
    pruneAction: '削除',
    pruned: ({ count }) => `古いバックアップを ${count} 件削除しました`,
    prunedNothing: '保持数を超えたものはありません',
    addCheck: 'チェックを追加',
    addCheckUnavailable:
      'ここではチェックを設定できません · マシンのサービスページを開いてください',
  },
} satisfies Record<SupportedLanguage, DeploymentSettingsTranslations>;
